import axios from "axios";
import dotenv from "dotenv";
dotenv.config();
console.log("REDIS_URL =", process.env.REDIS_URL);

import IORedis from "ioredis";
const connection = new IORedis(process.env.REDIS_URL);

import supabase from "../config/db.js";
import { Worker } from "bullmq";
import { updateProgress } from "../services/progressService.js";




const key = process.env.TRELLO_KEY;
const token = process.env.TRELLO_TOKEN;

// ===== helper =====
async function revert(cardId, itemId, state) {
  await axios.put(
    `https://api.trello.com/1/cards/${cardId}/checkItem/${itemId}`,
    null,
    { params: { state, key, token } }
  );
}

// ===== move using list_id =====
async function moveCard(cardId, targetListId) {

  // 🔥 check current list ก่อน
  const { data: card } = await axios.get(
    `https://api.trello.com/1/cards/${cardId}`,
    { params: { fields: "idList", key, token } }
  );

  if (card.idList === targetListId) {
    console.log("⏭ skip move (same list)");
    return;
  }

  console.log("🚀 MOVE to:", targetListId);

  await axios.put(
    `https://api.trello.com/1/cards/${cardId}`,
    null,
    {
      params: {
        idList: targetListId,
        key,
        token
      }
    }
  );
}

// =======================================================
// 🔥 WORKER
// =======================================================
const worker = new Worker(
  "workflow",
  async (job) => {
    const { cardId, itemId, state } = job.data;

    console.log("🔥 JOB:", cardId, itemId, state);

    // =======================================================
    // 1. LOAD STEP
    // =======================================================
    let step = await supabase
      .from("steps")
      .select("*")
      .eq("trello_item_id", itemId)
      .maybeSingle();

    if (!step) return;

    // =======================================================
    // 2. LOAD ALL STEPS (ครั้งเดียว)
    // =======================================================
    const { data: allSteps } = await supabase
      .from("steps")
      .select("*")
      .eq("job_id", step.job_id);

    if (!allSteps) return;

    // =======================================================
    // 3. BUILD MEMORY
    // =======================================================
    const parents = allSteps
      .filter(s => !s.parent_id)
      .sort((a, b) => a.step_order - b.step_order);

    const subMap = {};
    for (const s of allSteps) {
      if (s.parent_id) {
        if (!subMap[s.parent_id]) subMap[s.parent_id] = [];
        subMap[s.parent_id].push(s);
      }
    }

    const lastDoneIndex = parents.findLastIndex(p => p.status === "done");

    // =======================================================
    // 🔹 SUBSTEP
    // =======================================================
    if (step.parent_id) {

      await supabase
        .from("steps")
        .update({
          status: state === "complete" ? "done" : "pending"
        })
        .eq("id", step.id);

      const subs = subMap[step.parent_id] || [];
      const allDone = subs.every(s => s.status === "done");

      const parent = parents.find(p => p.id === step.parent_id);
      if (!parent) return;

      await supabase
        .from("steps")
        .update({
          status: allDone ? "done" : "pending"
        })
        .eq("id", parent.id);

      await revert(
        cardId,
        parent.trello_item_id,
        allDone ? "complete" : "incomplete"
      );

      if (!allDone && parent.status !== "done") return;

      step = parent; // 👉 ใช้ parent ต่อ
    }

    // =======================================================
    // 🔹 PARENT LOGIC
    // =======================================================
    const currentIndex = parents.findIndex(p => p.id === step.id);

    const subs = subMap[step.id] || [];
    const hasSub = subs.length > 0;

    if (hasSub && state === "complete") {
      console.log("❌ BLOCK parent");
      await revert(cardId, itemId, "incomplete");
      return;
    }

    // enforce latest
    if (state === "complete" && currentIndex !== lastDoneIndex + 1) {
      await revert(cardId, itemId, "incomplete");
      return;
    }

    if (state === "incomplete" && currentIndex !== lastDoneIndex) {
      await revert(cardId, itemId, "complete");
      return;
    }

    await supabase
      .from("steps")
      .update({
        status: state === "complete" ? "done" : "pending"
      })
      .eq("id", step.id);

    // =======================================================
    // UPDATE PROGRESS
    // =======================================================
    try {
      await updateProgress(itemId);
    } catch {}

    // =======================================================
    // MOVE CARD
    // =======================================================
    const index = parents.findIndex(p => p.id === step.id);

    let targetIndex =
      step.status === "done"
        ? index + 1
        : index - 1;

    targetIndex = Math.max(0, Math.min(targetIndex, parents.length - 1));

    const targetStep = parents[targetIndex];
    if (!targetStep) return;

    if (!targetStep.trello_list_id) {
      console.log("❌ missing trello_list_id");
      return;
    }

    await moveCard(cardId, targetStep.trello_list_id);
  },
  {
    connection,
    concurrency: 1
  }
);

worker.on("completed", job => {
  console.log("✅ done:", job.id);
});

worker.on("failed", (job, err) => {
  console.error("❌ failed:", err.message);
});
