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

// 🔥 กัน loop
const ignoreMap = new Map();
const IGNORE_TTL = 1500;

// =======================================================
// 🔥 BASIC
// =======================================================
app.get("/", (_, res) => {
  res.send("Workflow running 🚀");
});

// =======================================================
// 🔥 HELPERS
// =======================================================
async function revert(cardId, itemId, state) {
  console.log("↩️ revert:", itemId, state);

  ignoreMap.set(itemId, Date.now());

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

    // 🔥 LOOP GUARD
    const last = ignoreMap.get(itemId);
    if (last && Date.now() - last < IGNORE_TTL) {
      console.log("🛑 IGNORE LOOP:", itemId);
      return;
    }

    console.log("📩 webhook:", cardId, itemId, state);

    // ===================================================
    // 1. LOAD STEP
    // ===================================================
    const { data: step } = await supabase
      .from("steps")
      .select("*")
      .eq("trello_item_id", itemId)
      .maybeSingle();

    if (!step) return;

    // ===================================================
    // 2. LOAD ALL STEPS
    // ===================================================
    const { data: allSteps } = await supabase
      .from("steps")
      .select("*")
      .eq("job_id", step.job_id);

    const parents = allSteps
      .filter(s => !s.parent_id)
      .sort((a, b) => a.step_order - b.step_order);

    const getSubs = (parentId) =>
      allSteps.filter(s => s.parent_id === parentId);

    const parent = step.parent_id
      ? allSteps.find(p => p.id === step.parent_id)
      : step;

    const parentIndex = parents.findIndex(p => p.id === parent.id);
    const lastDoneIndex = parents.findLastIndex(p => p.status === "done");

    const hasSub = getSubs(parent.id).length > 0;

    // ===================================================
    // 3. UPDATE CURRENT STEP
    // ===================================================
    await supabase
      .from("steps")
      .update({
        status: isComplete ? "done" : "pending",
      })
      .eq("id", step.id);

    let blocked = false;

    // ===================================================
    // 4. SUBSTEP LOGIC
    // ===================================================
    if (step.parent_id) {
      const subs = getSubs(parent.id);
      const allDone = subs.every(s => s.status === "done");

      // update parent
      await supabase
        .from("steps")
        .update({
          status: allDone ? "done" : "pending",
        })
        .eq("id", parent.id);

      // sync parent check
      await revert(
        cardId,
        parent.trello_item_id,
        allDone ? "complete" : "incomplete"
      );

      // 🔥 move based on parent
      const targetIndex = allDone ? parentIndex + 1 : parentIndex;
      const target = parents[targetIndex] || parents[parentIndex];

      if (target?.trello_list_id) {
        await moveCard(cardId, target.trello_list_id);
      }

      await updateProgress(itemId);
      return;
    }

    // ===================================================
    // 5. PARENT RULES
    // ===================================================

    // ❌ parent มี sub → ห้าม user check
    if (hasSub && isComplete) {
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
    // 6. MOVE CARD
    // ===================================================
    const targetIndex = isComplete
      ? parentIndex + 1
      : parentIndex;

    const target = parents[targetIndex] || parents[parentIndex];

    if (target?.trello_list_id) {
      await moveCard(cardId, target.trello_list_id);
    }

    // ===================================================
    // 7. PROGRESS
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
