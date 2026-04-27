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
// 🔥 LOOP GUARD (กัน webhook ยิงซ้ำจาก revert)
// =======================================================
const ignoreMap = new Map();

function shouldIgnore(itemId) {
  const t = ignoreMap.get(itemId);
  if (!t) return false;
  if (Date.now() > t) {
    ignoreMap.delete(itemId);
    return false;
  }
  return true;
}

function markIgnore(itemId) {
  ignoreMap.set(itemId, Date.now() + 500);
}

// =======================================================
// 🔥 HELPERS
// =======================================================
async function revert(cardId, itemId, state) {
  console.log("↩️ revert:", itemId, state);

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
    // ❌ BLOCK: check substep ก่อนถึง step
    // ===================================================
    if (step.parent_id && parentIndex !== lastDoneIndex + 1) {
      await revert(cardId, itemId, "incomplete");
      return;
    }

    // ===================================================
    // ❌ BLOCK: user check parent ที่มี substep
    // ===================================================
    if (!step.parent_id && hasSub && isComplete) {
      await revert(cardId, itemId, "incomplete");
      return;
    }

    // ===================================================
    // ❌ BLOCK: forward skip
    // ===================================================
    if (!step.parent_id && isComplete && parentIndex !== lastDoneIndex + 1) {
      await revert(cardId, itemId, "incomplete");
      return;
    }

    // ===================================================
    // ❌ BLOCK: backward skip
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
    // 🔥 SUBSTEP LOGIC
    // ===================================================
    if (step.parent_id) {
      const updatedSubs = await supabase
        .from("steps")
        .select("*")
        .eq("parent_id", parent.id);

      const allDone = updatedSubs.data.every(s => s.status === "done");

      // ✅ auto check / uncheck parent
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

      // 👉 move
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
    // 🔥 NORMAL PARENT MOVE
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



















import supabase from "../config/db.js";
import { createCard, createChecklist, addChecklistItem } from "./trello.js";

export async function createJobWithSteps(body) {
  const { name, listId, job, steps } = body;

  if (!name || !listId || !job || !steps) {
    throw new Error("missing required fields");
  }

  // ===================================================
  // 1. CREATE CARD
  // ===================================================
  const card = await createCard(name, listId);

  // ===================================================
  // 2. CREATE JOB
  // ===================================================
  const { data: jobRow, error: jobError } = await supabase
    .from("jobs")
    .insert({
      po_number: job.po_number,
      customer: job.customer
    })
    .select()
    .single();

  if (jobError) throw jobError;

  // ===================================================
  // 3. CREATE CHECKLIST
  // ===================================================
  const checklist = await createChecklist(card.id, "Workflow");

  // ===================================================
  // 4. CREATE STEPS
  // ===================================================
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // 🔥 parent DB
    const { data: parent } = await supabase
      .from("steps")
      .insert({
        job_id: jobRow.id,
        card_id: card.id,
        name: step.name,
        step_order: i + 1,
        status: "pending",
        trello_list_id: step.trello_list_id
      })
      .select()
      .single();

    // 🔥 parent checklist
    const parentItem = await addChecklistItem(
      checklist.id,
      step.name
    );

    await supabase
      .from("steps")
      .update({ trello_item_id: parentItem.id })
      .eq("id", parent.id);

    // 🔥 substeps
    if (step.substeps) {
      for (let j = 0; j < step.substeps.length; j++) {
        const sub = step.substeps[j];

        const subItem = await addChecklistItem(
          checklist.id,
          `(${sub.name})`
        );

        await supabase
          .from("steps")
          .insert({
            job_id: jobRow.id,
            card_id: card.id,
            parent_id: parent.id,
            name: sub.name,
            step_order: j + 1,
            status: "pending",
            trello_item_id: subItem.id
          });
      }
    }
  }

  return {
    success: true,
    cardId: card.id,
    jobId: jobRow.id
  };
}
