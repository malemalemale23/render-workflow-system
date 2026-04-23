import dotenv from "dotenv";
dotenv.config();
import IORedis from "ioredis";

const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});


import axios from "axios";

import { Worker } from "bullmq";

import supabase from "../config/db.js";
import { updateProgress } from "../services/progressService.js";





const key = process.env.TRELLO_KEY;
const token = process.env.TRELLO_TOKEN;

// =========================
// Trello helpers
// =========================
async function revert(cardId, itemId, state) {
  await axios.put(
    `https://api.trello.com/1/cards/${cardId}/checkItem/${itemId}`,
    null,
    { params: { state, key, token } }
  );
}

async function moveCard(cardId, targetListId) {
  const { data: card } = await axios.get(
    `https://api.trello.com/1/cards/${cardId}`,
    { params: { fields: "idList", key, token } }
  );

  if (card.idList === targetListId) return;

  await axios.put(
    `https://api.trello.com/1/cards/${cardId}`,
    null,
    { params: { idList: targetListId, key, token } }
  );
}

// =========================
// WORKER
// =========================
const worker = new Worker(
  "workflow",
  async (job) => {
    const { cardId, itemId, state } = job.data;

    console.log("🔥 JOB:", cardId, itemId, state);

    // =========================
    // 1. LOAD STEP
    // =========================
    const { data: step, error } = await supabase
      .from("steps")
      .select("*")
      .eq("trello_item_id", itemId)
      .single();

    if (error || !step) return;

    const isComplete = state === "complete";

    // =========================
    // 2. UPDATE CURRENT STEP
    // =========================
    await supabase
      .from("steps")
      .update({
        status: isComplete ? "done" : "pending"
      })
      .eq("id", step.id);

    // =========================
    // 3. SUBSTEP LOGIC
    // =========================
    let parentStep = null;

    if (step.parent_id) {
      // load parent
      const { data: parent } = await supabase
        .from("steps")
        .select("*")
        .eq("id", step.parent_id)
        .single();

      if (!parent) return;

      parentStep = parent;

      // load ALL substeps fresh (IMPORTANT)
      const { data: subs } = await supabase
        .from("steps")
        .select("*")
        .eq("parent_id", parent.id);

      const allDone = subs.every(s => s.status === "done");

      // update parent
      await supabase
        .from("steps")
        .update({
          status: allDone ? "done" : "pending"
        })
        .eq("id", parent.id);

      // sync trello parent checkbox
      await revert(
        cardId,
        parent.trello_item_id,
        allDone ? "complete" : "incomplete"
      );

    } else {
      parentStep = step;
    }

    // =========================
    // 4. LOAD ALL PARENTS (ORDER)
    // =========================
    const { data: allSteps } = await supabase
      .from("steps")
      .select("*")
      .eq("job_id", parentStep.job_id);

    const parents = allSteps
      .filter(s => !s.parent_id)
      .sort((a, b) => a.step_order - b.step_order);

    const index = parents.findIndex(p => p.id === parentStep.id);
    if (index === -1) return;

    // =========================
    // 5. RULE ENGINE (STRICT)
    // =========================

    const lastDoneIndex = parents.findLastIndex(p => p.status === "done");

    const hasSub = allSteps.some(
      s => s.parent_id === parentStep.id
    );

    // ❌ block parent check if has substeps
    if (!step.parent_id && hasSub && isComplete) {
      await revert(cardId, itemId, "incomplete");
      return;
    }

    // ❌ enforce sequential forward
    if (isComplete && index !== lastDoneIndex + 1) {
      await revert(cardId, itemId, "incomplete");
      return;
    }

    // ❌ enforce sequential backward
    if (!isComplete && index !== lastDoneIndex) {
      await revert(cardId, itemId, "complete");
      return;
    }

    // =========================
    // 6. PROGRESS UPDATE
    // =========================
    try {
      await updateProgress(itemId);
    } catch {}

    // =========================
    // 7. MOVE CARD (DETERMINISTIC)
    // =========================
    const targetIndex = isComplete ? index + 1 : index - 1;

    const clampedIndex = Math.max(
      0,
      Math.min(targetIndex, parents.length - 1)
    );

    const target = parents[clampedIndex];

    if (!target?.trello_list_id) return;

    await moveCard(cardId, target.trello_list_id);
  },
  {
    connection,
    concurrency: 1
  }
);

// =========================
worker.on("completed", job => {
  console.log("✅ done:", job.id);
});

worker.on("failed", (job, err) => {
  console.error("❌ failed:", err.message);
});
