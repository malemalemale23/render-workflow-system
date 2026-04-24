import dotenv from "dotenv";
dotenv.config();

import express from "express";
import axios from "axios";
import supabase from "./config/db.js";
import { updateProgress } from "./services/progressService.js";
import { createJobWithSteps } from "./services/createJob.js";

const app = express();
app.use(express.json());

const key = process.env.TRELLO_KEY;
const token = process.env.TRELLO_TOKEN;

// =======================================================
// 🔥 ANTI LOOP (สำคัญมาก)
// =======================================================
const recentActions = new Map();

function isDuplicate(cardId, itemId, state) {
  const key = `${cardId}-${itemId}`;
  const last = recentActions.get(key);
  const now = Date.now();

  if (last && last.state === state && now - last.time < 800) {
    return true;
  }

  recentActions.set(key, { state, time: now });
  return false;
}

// =======================================================
// 🔥 HELPERS
// =======================================================
async function safeRevert(cardId, itemId, desiredState) {
  const { data } = await axios.get(
    `https://api.trello.com/1/cards/${cardId}/checklists`,
    { params: { key, token } }
  );

  const item = data
    .flatMap(c => c.checkItems)
    .find(i => i.id === itemId);

  if (!item) return;

  if (item.state === desiredState) return; // 🔥 กัน loop

  await axios.put(
    `https://api.trello.com/1/cards/${cardId}/checkItem/${itemId}`,
    null,
    { params: { state: desiredState, key, token } }
  );
}

async function moveCard(cardId, targetListId) {
  const { data: card } = await axios.get(
    `https://api.trello.com/1/cards/${cardId}`,
    { params: { fields: "idList", key, token } }
  );

  if (card.idList === targetListId) return;

  console.log("🚀 MOVE →", targetListId);

  await axios.put(
    `https://api.trello.com/1/cards/${cardId}`,
    null,
    { params: { idList: targetListId, key, token } }
  );
}

// =======================================================
// 🔥 ROUTES
// =======================================================
app.get("/", (_, res) => res.send("OK"));

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
// 🔥 WEBHOOK CORE
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

    // 🔥 กัน loop
    if (isDuplicate(cardId, itemId, state)) {
      console.log("🛑 skip duplicate");
      return;
    }

    console.log("📩 webhook:", cardId, itemId, state);

    // ===================================================
    // LOAD STEP
    // ===================================================
    const { data: step } = await supabase
      .from("steps")
      .select("*")
      .eq("trello_item_id", itemId)
      .single();

    if (!step) return;

    // ===================================================
    // LOAD ALL
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
    // 🔥 VALIDATION
    // ===================================================

    if (!step.parent_id && hasSub && isComplete) {
      await safeRevert(cardId, itemId, "incomplete");
      return;
    }

    if (isComplete && parentIndex !== lastDoneIndex + 1) {
      await safeRevert(cardId, itemId, "incomplete");
      return;
    }

    if (!isComplete && parentIndex !== lastDoneIndex) {
      await safeRevert(cardId, itemId, "complete");
      return;
    }

    // ===================================================
    // UPDATE STEP
    // ===================================================
    await supabase
      .from("steps")
      .update({
        status: isComplete ? "done" : "pending",
      })
      .eq("id", step.id);

    // ===================================================
    // SUBSTEP LOGIC
    // ===================================================
    if (step.parent_id) {
      const subs = getSubs(parent.id);

      const allDone = subs.every(s =>
        s.id === step.id ? isComplete : s.status === "done"
      );

      await supabase
        .from("steps")
        .update({
          status: allDone ? "done" : "pending",
        })
        .eq("id", parent.id);

      await safeRevert(
        cardId,
        parent.trello_item_id,
        allDone ? "complete" : "incomplete"
      );

      const targetIndex = allDone ? parentIndex + 1 : parentIndex;
      const target = parents[targetIndex] || parents[parentIndex];

      if (target?.trello_list_id) {
        await moveCard(cardId, target.trello_list_id);
      }

      await updateProgress(itemId);
      return;
    }

    // ===================================================
    // MOVE CARD (parent)
    // ===================================================
    const targetIndex = isComplete ? parentIndex + 1 : parentIndex;
    const target = parents[targetIndex] || parents[parentIndex];

    if (target?.trello_list_id) {
      await moveCard(cardId, target.trello_list_id);
    }

    await updateProgress(itemId);

  } catch (err) {
    console.error("WEBHOOK ERROR:", err.message);
  }
});

// =======================================================
app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Server running");
});
