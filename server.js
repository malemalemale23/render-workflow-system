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

// 🔥 กัน loop webhook
const lockSet = new Set();

// =======================================================
// BASIC
// =======================================================
app.get("/", (_, res) => {
  res.send("Workflow running 🚀");
});

// =======================================================
// HELPERS
// =======================================================
async function trelloSetState(cardId, itemId, state) {
  await axios.put(
    `https://api.trello.com/1/cards/${cardId}/checkItem/${itemId}`,
    null,
    { params: { state, key, token } }
  );
}

async function moveCard(cardId, listId) {
  const { data } = await axios.get(
    `https://api.trello.com/1/cards/${cardId}`,
    { params: { fields: "idList", key, token } }
  );

  if (data.idList === listId) return;

  console.log("🚀 MOVE →", listId);

  await axios.put(
    `https://api.trello.com/1/cards/${cardId}`,
    null,
    { params: { idList: listId, key, token } }
  );
}

// =======================================================
// CREATE JOB
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
// WEBHOOK
// =======================================================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const action = req.body?.action;
    if (!action || action.type !== "updateCheckItemStateOnCard") return;

    const cardId = action.data.card.id;
    const itemId = action.data.checkItem.id;
    const isComplete = action.data.checkItem.state === "complete";

    // 🔥 กัน loop จากการ revert
    if (lockSet.has(itemId)) {
      console.log("🛑 skip loop:", itemId);
      lockSet.delete(itemId);
      return;
    }

    console.log("📩", cardId, itemId, isComplete);

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
    // LOAD ALL STEPS
    // ===================================================
    const { data: all } = await supabase
      .from("steps")
      .select("*")
      .eq("job_id", step.job_id);

    const parents = all
      .filter(s => !s.parent_id)
      .sort((a, b) => a.step_order - b.step_order);

    const getSubs = (pid) => all.filter(s => s.parent_id === pid);

    const parent = step.parent_id
      ? all.find(s => s.id === step.parent_id)
      : step;

    const parentIndex = parents.findIndex(p => p.id === parent.id);
    const lastDoneIndex = parents.findLastIndex(p => p.status === "done");

    const subs = getSubs(parent.id);
    const hasSub = subs.length > 0;

    // ===================================================
    // ❌ RULE 1: parent มี sub → user check ไม่ได้
    // ===================================================
    if (!step.parent_id && hasSub && isComplete) {
      lockSet.add(itemId);
      await trelloSetState(cardId, itemId, "incomplete");
      return;
    }

    // ===================================================
    // ❌ RULE 2: check ข้าม step
    // ===================================================
    if (!step.parent_id) {
      if (isComplete && parentIndex !== lastDoneIndex + 1) {
        lockSet.add(itemId);
        await trelloSetState(cardId, itemId, "incomplete");
        return;
      }

      if (!isComplete && parentIndex !== lastDoneIndex) {
        lockSet.add(itemId);
        await trelloSetState(cardId, itemId, "complete");
        return;
      }
    }

    // ===================================================
    // UPDATE CURRENT STEP
    // ===================================================
    await supabase
      .from("steps")
      .update({
        status: isComplete ? "done" : "pending"
      })
      .eq("id", step.id);

    // ===================================================
    // 🔥 SUBSTEP LOGIC
    // ===================================================
    if (step.parent_id) {
      // reload fresh
      const { data: freshSubs } = await supabase
        .from("steps")
        .select("*")
        .eq("parent_id", parent.id);

      const allDone = freshSubs.every(s => s.status === "done");

      // update parent status
      await supabase
        .from("steps")
        .update({
          status: allDone ? "done" : "pending"
        })
        .eq("id", parent.id);

      // 🔥 auto sync parent checkbox
      lockSet.add(parent.trello_item_id);

      await trelloSetState(
        cardId,
        parent.trello_item_id,
        allDone ? "complete" : "incomplete"
      );

      // 🔥 MOVE CARD
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
    // 🔥 PARENT MOVE
    // ===================================================
    const targetIndex = isComplete
      ? parentIndex + 1
      : parentIndex;

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
