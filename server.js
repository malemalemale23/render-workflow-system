import dotenv from "dotenv";
dotenv.config();

import express from "express";
import axios from "axios";
import supabase from "./config/db.js";
import { updateProgress } from "./services/progressService.js";
import { createJobWithSteps } from "./services/createJob.js";

const app = express();
app.use(express.json());

// =======================================================
// 🔥 CONFIG
// =======================================================
const key = process.env.TRELLO_KEY;
const token = process.env.TRELLO_TOKEN;

// 🔥 กัน webhook loop
const processing = new Set();

// =======================================================
// 🔥 BASIC
// =======================================================
app.get("/", (_, res) => {
  res.send("Workflow system running 🚀");
});

// =======================================================
// 🔥 HELPERS
// =======================================================
async function revert(cardId, itemId, state) {
  console.log("↩️ revert", itemId, state);

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

  if (card.idList === targetListId) {
    console.log("⏭ skip move");
    return;
  }

  console.log("🚀 MOVE →", targetListId);

  await axios.put(
    `https://api.trello.com/1/cards/${cardId}`,
    null,
    { params: { idList: targetListId, key, token } }
  );
}

// =======================================================
// 🔥 CREATE JOB
// =======================================================
app.post("/create-job", async (req, res) => {
  try {
    const result = await createJobWithSteps(req.body);
    res.json(result);
  } catch (err) {
    console.error("CREATE JOB ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =======================================================
// 🔥 WEBHOOK (CORE LOGIC ใหม่)
// =======================================================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const action = req.body?.action;
    if (!action || action.type !== "updateCheckItemStateOnCard") return;

    const cardId = action.data.card.id;
    const itemId = action.data.checkItem.id;
    const state = action.data.checkItem.state;
    const isComplete = state === "complete";

    const lockKey = `${cardId}-${itemId}`;
    if (processing.has(lockKey)) return;
    processing.add(lockKey);

    setTimeout(() => processing.delete(lockKey), 500);

    console.log("📩 webhook:", cardId, itemId, state);

    // ===================================================
    // 1. LOAD STEP
    // ===================================================
    const { data: step } = await supabase
      .from("steps")
      .select("*")
      .eq("trello_item_id", itemId)
      .single();

    if (!step) return;

    // ===================================================
    // 2. LOAD ALL
    // ===================================================
    const { data: allSteps } = await supabase
      .from("steps")
      .select("*")
      .eq("job_id", step.job_id);

    const parents = allSteps
      .filter(s => !s.parent_id)
      .sort((a, b) => a.step_order - b.step_order);

    const getSubs = (pid) => allSteps.filter(s => s.parent_id === pid);

    const parent = step.parent_id
      ? allSteps.find(p => p.id === step.parent_id)
      : step;

    const parentIndex = parents.findIndex(p => p.id === parent.id);
    const lastDoneIndex = parents.findLastIndex(p => p.status === "done");

    const hasSub = getSubs(parent.id).length > 0;

    // ===================================================
    // 🔥 3. VALIDATION FIRST (สำคัญสุด)
    // ===================================================

    // ❌ parent มี sub → user ห้าม check
    if (!step.parent_id && hasSub && isComplete) {
      await revert(cardId, itemId, "incomplete");
      return;
    }

    // ❌ forward skip
    if (isComplete && parentIndex !== lastDoneIndex + 1) {
      await revert(cardId, itemId, "incomplete");
      return;
    }

    // ❌ backward skip
    if (!isComplete && parentIndex !== lastDoneIndex) {
      await revert(cardId, itemId, "complete");
      return;
    }

    // ===================================================
    // 🔥 4. UPDATE DB
    // ===================================================
    await supabase
      .from("steps")
      .update({
        status: isComplete ? "done" : "pending",
      })
      .eq("id", step.id);

    // ===================================================
    // 🔥 5. SUBSTEP LOGIC
    // ===================================================
    if (step.parent_id) {
      const subs = getSubs(parent.id);

      const allDone = subs.every(s =>
        s.id === step.id
          ? isComplete
          : s.status === "done"
      );

      // update parent
      await supabase
        .from("steps")
        .update({
          status: allDone ? "done" : "pending",
        })
        .eq("id", parent.id);

      // sync trello parent
      await revert(
        cardId,
        parent.trello_item_id,
        allDone ? "complete" : "incomplete"
      );

      // 🔥 MOVE
      const targetIndex = allDone
        ? parentIndex + 1
        : parentIndex;

      const target = parents[targetIndex] || parents[parentIndex];

      if (target?.trello_list_id) {
        await moveCard(cardId, target.trello_list_id);
      }

      await updateProgress(itemId);
      return;
    }

    // ===================================================
    // 🔥 6. MOVE CARD (parent only)
    // ===================================================
    const targetIndex = isComplete
      ? parentIndex + 1
      : parentIndex;

    const target = parents[targetIndex] || parents[parentIndex];

    if (target?.trello_list_id) {
      await moveCard(cardId, target.trello_list_id);
    }

    // ===================================================
    // 🔥 7. PROGRESS
    // ===================================================
    await updateProgress(itemId);

  } catch (err) {
    console.error("WEBHOOK ERROR:", err.message);
  }
});

// =======================================================
app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Server running");
});
