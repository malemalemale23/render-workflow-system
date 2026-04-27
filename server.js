import dotenv from "dotenv";
dotenv.config();

import express from "express";
import axios from "axios";
import supabase from "./config/db.js";
import { createJobWithSteps } from "./services/createJob.js";

const app = express();
app.use(express.json());

const key = process.env.TRELLO_KEY;
const token = process.env.TRELLO_TOKEN;

// ================= LOOP GUARD =================
const ignore = new Map();

// ================= CREATE JOB =================
app.post("/create-job", async (req, res) => {
  try {
    const result = await createJobWithSteps(req.body);
    res.json(result);
  } catch (err) {
    console.error("CREATE JOB ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

function mark(id) {
  ignore.set(id, Date.now() + 1500); // 🔥 เพิ่มเป็น 1.5s
}

function blocked(id) {
  const t = ignore.get(id);
  if (!t) return false;
  if (Date.now() > t) {
    ignore.delete(id);
    return false;
  }
  return true;
}

// ================= HELPERS =================
async function revert(cardId, itemId, state) {
  mark(itemId);
  console.log("↩️ revert:", itemId, state);

  await axios.put(
    `https://api.trello.com/1/cards/${cardId}/checkItem/${itemId}`,
    null,
    { params: { state, key, token } }
  );
}

async function sync(cardId, itemId, state) {
  mark(itemId);
  console.log("🔁 sync:", itemId, state);

  await axios.put(
    `https://api.trello.com/1/cards/${cardId}/checkItem/${itemId}`,
    null,
    { params: { state, key, token } }
  );
}

async function move(cardId, listId) {
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

// ================= WEBHOOK =================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const action = req.body?.action;
    if (!action || action.type !== "updateCheckItemStateOnCard") return;

    const cardId = action.data.card.id;
    const itemId = action.data.checkItem.id;
    const isComplete = action.data.checkItem.state === "complete";

    if (blocked(itemId)) {
      console.log("🛑 ignore loop");
      return;
    }

    console.log("📩", itemId, isComplete);

    // ================= LOAD =================
    const { data: step } = await supabase
      .from("steps")
      .select("*")
      .eq("trello_item_id", itemId)
      .single();

    if (!step) return;

    const { data: all } = await supabase
      .from("steps")
      .select("*")
      .eq("job_id", step.job_id);

    const parents = all
      .filter(s => !s.parent_id)
      .sort((a, b) => a.step_order - b.step_order);

    const parent = step.parent_id
      ? all.find(s => s.id === step.parent_id)
      : step;

    const subs = all.filter(s => s.parent_id === parent.id);

    const parentIndex = parents.findIndex(p => p.id === parent.id);

    const lastDoneIndex = parents.findLastIndex(p => p.status === "done");
    const currentIndex = lastDoneIndex + 1;

    const hasSub = subs.length > 0;

    // =================================================
    // ❌ VALIDATION (STOP EVERYTHING IF FAIL)
    // =================================================

    // ❌ ห้ามกดอนาคต
    if (parentIndex > currentIndex) {
      await revert(cardId, itemId, isComplete ? "incomplete" : "complete");
      return;
    }

    // ❌ parent มี sub → ห้ามกดเอง
    if (!step.parent_id && hasSub && isComplete) {
      await revert(cardId, itemId, "incomplete");
      return;
    }

    // ❌ parent ต้องเรียง
    if (!step.parent_id && isComplete && parentIndex !== currentIndex) {
      await revert(cardId, itemId, "incomplete");
      return;
    }

    // ❌ substep ต้องอยู่ step ปัจจุบัน
    if (step.parent_id && parentIndex !== currentIndex) {
      await revert(cardId, itemId, isComplete ? "incomplete" : "complete");
      return;
    }

    // =================================================
    // ✅ UPDATE CURRENT STEP
    // =================================================
    await supabase
      .from("steps")
      .update({
        status: isComplete ? "done" : "pending"
      })
      .eq("id", step.id);

    // =================================================
    // 🔥 SUBSTEP FLOW
    // =================================================
    if (step.parent_id) {
      const { data: updatedSubs } = await supabase
        .from("steps")
        .select("*")
        .eq("parent_id", parent.id);

      const allDone = updatedSubs.every(s => s.status === "done");

      // update parent
      await supabase
        .from("steps")
        .update({
          status: allDone ? "done" : "pending"
        })
        .eq("id", parent.id);

      // 🔥 sync parent ONCE
      await sync(
        cardId,
        parent.trello_item_id,
        allDone ? "complete" : "incomplete"
      );

      // 🔥 move
      const targetIndex = allDone
        ? parentIndex + 1
        : parentIndex;

      const target = parents[targetIndex] || parents[parentIndex];

      if (target?.trello_list_id) {
        await move(cardId, target.trello_list_id);
      }

      return;
    }

    // =================================================
    // 🔥 NORMAL PARENT FLOW
    // =================================================
    const targetIndex = isComplete
      ? parentIndex + 1
      : parentIndex;

    const target = parents[targetIndex] || parents[parentIndex];

    if (target?.trello_list_id) {
      await move(cardId, target.trello_list_id);
    }

  } catch (err) {
    console.error("ERR:", err.message);
  }
});

app.listen(3000, () => {
  console.log("🚀 running");
});
