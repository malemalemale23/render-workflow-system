import dotenv from "dotenv";
dotenv.config();

import express from "express";
import axios from "axios";
import supabase from "./config/db.js";

const app = express();
app.use(express.json());

const key = process.env.TRELLO_KEY;
const token = process.env.TRELLO_TOKEN;

// =======================================================
// 🔥 LOOP GUARD (สำคัญมาก)
// =======================================================
const ignoreMap = new Map();

function markIgnore(id) {
  ignoreMap.set(id, Date.now() + 800);
}

function shouldIgnore(id) {
  const t = ignoreMap.get(id);
  if (!t) return false;
  if (Date.now() > t) {
    ignoreMap.delete(id);
    return false;
  }
  return true;
}

// =======================================================
// 🔥 HELPERS
// =======================================================

// ❌ สำหรับ error only
async function revert(cardId, itemId, state) {
  console.log("↩️ revert:", itemId, state);
  markIgnore(itemId);

  await axios.put(
    `https://api.trello.com/1/cards/${cardId}/checkItem/${itemId}`,
    null,
    { params: { state, key, token } }
  );
}

// ✅ สำหรับ auto logic
async function syncCheck(cardId, itemId, state) {
  console.log("🔁 sync:", itemId, state);
  markIgnore(itemId);

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
// 🔥 CREATE JOB
// =======================================================
import { createJobWithSteps } from "./services/createJob.js";

app.post("/create-job", async (req, res) => {
  try {
    const result = await createJobWithSteps(req.body);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// =======================================================
// 🔥 WEBHOOK
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

    if (shouldIgnore(itemId)) {
      console.log("🛑 ignore loop");
      return;
    }

    console.log("📩", cardId, itemId, isComplete);

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
    // ❌ BLOCK: substep ก่อนถึง step
    // ===================================================
    if (step.parent_id && parentIndex !== lastDoneIndex + 1) {
      await revert(cardId, itemId, "incomplete");
      return;
    }

    // ===================================================
    // ❌ BLOCK: parent ที่มี substep
    // ===================================================
    if (!step.parent_id && hasSub && isComplete) {
      await revert(cardId, itemId, "incomplete");
      return;
    }

    // ===================================================
    // ❌ BLOCK: skip forward
    // ===================================================
    if (!step.parent_id && isComplete && parentIndex !== lastDoneIndex + 1) {
      await revert(cardId, itemId, "incomplete");
      return;
    }

    // ===================================================
    // ❌ BLOCK: skip backward
    // ===================================================
    if (!step.parent_id && !isComplete && parentIndex !== lastDoneIndex) {
      await revert(cardId, itemId, "complete");
      return;
    }

    // ===================================================
    // ✅ UPDATE CURRENT STEP
    // ===================================================
    await supabase
      .from("steps")
      .update({
        status: isComplete ? "done" : "pending"
      })
      .eq("id", step.id);

    // ===================================================
    // 🔥 SUBSTEP LOGIC (FIXED)
    // ===================================================
    if (step.parent_id) {
      const { data: updatedSubs } = await supabase
        .from("steps")
        .select("*")
        .eq("parent_id", parent.id);

      const allDone = updatedSubs.every(s => s.status === "done");

      await supabase
        .from("steps")
        .update({
          status: allDone ? "done" : "pending"
        })
        .eq("id", parent.id);

      // ✅ IMPORTANT: use syncCheck (ไม่ใช่ revert)
      await syncCheck(
        cardId,
        parent.trello_item_id,
        allDone ? "complete" : "incomplete"
      );

      const targetIndex = allDone
        ? parentIndex + 1
        : parentIndex;

      const target = parents[targetIndex] || parents[parentIndex];

      if (target?.trello_list_id) {
        await moveCard(cardId, target.trello_list_id);
      }

      return;
    }

    // ===================================================
    // 🔥 NORMAL MOVE
    // ===================================================
    const targetIndex = isComplete
      ? parentIndex + 1
      : parentIndex;

    const target = parents[targetIndex] || parents[parentIndex];

    if (target?.trello_list_id) {
      await moveCard(cardId, target.trello_list_id);
    }

  } catch (err) {
    console.error("WEBHOOK ERROR:", err.message);
  }
});

// =======================================================
app.listen(3000, () => {
  console.log("🚀 Server running");
});
