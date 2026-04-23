import { Worker } from "bullmq";
import IORedis from "ioredis";
import axios from "axios";
import dotenv from "dotenv";

import supabase from "../config/db.js";
import { updateProgress } from "../services/progressService.js";

dotenv.config();

const connection = new IORedis(process.env.REDIS_URL);

const key = process.env.TRELLO_KEY;
const token = process.env.TRELLO_TOKEN;

// ===== helper: revert trello state =====
async function revert(cardId, itemId, state) {
  await axios.put(
    `https://api.trello.com/1/cards/${cardId}/checkItem/${itemId}`,
    null,
    { params: { state, key, token } }
  );
}

// ===== helper: move card =====
async function moveCard(cardId, boardId, columnName) {
  const { data: lists } = await axios.get(
    `https://api.trello.com/1/boards/${boardId}/lists`,
    { params: { key, token } }
  );

  const target = lists.find(l => l.name === columnName);
  if (!target) {
    console.log("❌ list not found:", columnName);
    return;
  }

  console.log("🚀 MOVE:", columnName);

  await axios.put(
    `https://api.trello.com/1/cards/${cardId}`,
    null,
    {
      params: {
        idList: target.id,
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
    const { cardId, boardId, itemId, state } = job.data;

    console.log("🔥 JOB:", cardId, itemId, state);

    // =======================================================
    // 1. LOAD STEP
    // =======================================================
    const { data: step, error } = await supabase
      .from("steps")
      .select("*")
      .eq("trello_item_id", itemId)
      .maybeSingle();

    if (error || !step) return;

    // =======================================================
    // 2. LOAD ALL PARENTS
    // =======================================================
    const { data: parents } = await supabase
      .from("steps")
      .select("*")
      .eq("job_id", step.job_id)
      .is("parent_id", null)
      .order("step_order", { ascending: true });

    if (!parents || parents.length === 0) return;

    // helper
    const lastDoneIndex = parents.findLastIndex(p => p.status === "done");

    // =======================================================
    // 3. HANDLE SUBSTEP
    // =======================================================
    if (step.parent_id) {

      // update substep
      await supabase
        .from("steps")
        .update({
          status: state === "complete" ? "done" : "pending"
        })
        .eq("id", step.id);

      // get siblings
      const { data: subs } = await supabase
        .from("steps")
        .select("*")
        .eq("parent_id", step.parent_id);

      const allDone = subs.every(s => s.status === "done");

      // get parent
      const { data: parent } = await supabase
        .from("steps")
        .select("*")
        .eq("id", step.parent_id)
        .single();

      if (!parent) return;

      // update parent DB
      await supabase
        .from("steps")
        .update({
          status: allDone ? "done" : "pending"
        })
        .eq("id", parent.id);

      // sync trello parent
      await revert(
        cardId,
        parent.trello_item_id,
        allDone ? "complete" : "incomplete"
      );

      // 👉 ถ้า parent status ไม่เปลี่ยน → ไม่ move
      if (!allDone && parent.status !== "done") return;

      // 👉 continue ไป move (ด้านล่าง)
    }

    // =======================================================
    // 4. HANDLE PARENT
    // =======================================================
    else {

      const currentIndex = parents.findIndex(p => p.id === step.id);

      // 🔍 check substeps
      const { data: subs } = await supabase
        .from("steps")
        .select("*")
        .eq("parent_id", step.id);

      const hasSub = subs.length > 0;

      // ❌ parent ที่มี substep → user ห้ามติ๊ก
      if (hasSub && state === "complete") {
        console.log("❌ BLOCK parent (has sub)");
        await revert(cardId, itemId, "incomplete");
        return;
      }

      // 🔥 enforce latest step rule

      // ✅ check
      if (state === "complete") {
        if (currentIndex !== lastDoneIndex + 1) {
          console.log("❌ BLOCK skip");
          await revert(cardId, itemId, "incomplete");
          return;
        }
      }

      // ✅ uncheck
      if (state === "incomplete") {
        if (currentIndex !== lastDoneIndex) {
          console.log("❌ BLOCK uncheck middle");
          await revert(cardId, itemId, "complete");
          return;
        }
      }

      // update DB
      await supabase
        .from("steps")
        .update({
          status: state === "complete" ? "done" : "pending"
        })
        .eq("id", step.id);
    }

    // =======================================================
    // 5. UPDATE PROGRESS
    // =======================================================
    try {
      await updateProgress(itemId);
    } catch {
      console.log("progress skip");
    }

    // =======================================================
    // 6. MOVE CARD (BASED ON PARENT)
    // =======================================================

    // 👉 หา parent step
    let parentStep = step;

    if (step.parent_id) {
      const { data } = await supabase
        .from("steps")
        .select("*")
        .eq("id", step.parent_id)
        .single();

      parentStep = data;
    }

    if (!parentStep) return;

    const currentIndex = parents.findIndex(p => p.id === parentStep.id);

    let targetIndex;

    if (parentStep.status === "done") {
      targetIndex = currentIndex + 1;
    } else {
      targetIndex = currentIndex - 1;
    }

    targetIndex = Math.max(0, Math.min(targetIndex, parents.length - 1));

    const targetStep = parents[targetIndex];
    if (!targetStep) return;

    await moveCard(cardId, boardId, targetStep.name);
  },
  {
    connection,
    concurrency: 1 // 🔥 กันชน 100%
  }
);

// ===== EVENTS =====
worker.on("completed", job => {
  console.log("✅ done:", job.id);
});

worker.on("failed", (job, err) => {
  console.error("❌ failed:", err.message);
});
