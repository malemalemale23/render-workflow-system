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
// 🔥 ANTI LOOP + DEBOUNCE
// =======================================================
const ignoreMap = new Map();
const debounceMap = new Map();

const IGNORE_TTL = 1500;
const DEBOUNCE_MS = 300;

// =======================================================
// 🔥 BASIC
// =======================================================
app.get("/", (_, res) => res.send("OK"));

app.post("/create-job", async (req, res) => {
  try {
    const result = await createJobWithSteps(req.body);
    res.json(result);
  } catch (err) {
    console.error(err.message);
    res.status(500).send("error");
  }
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
  const { data } = await axios.get(
    `https://api.trello.com/1/cards/${cardId}`,
    { params: { fields: "idList", key, token } }
  );

  if (data.idList === targetListId) return;

  console.log("🚀 MOVE →", targetListId);

  await axios.put(
    `https://api.trello.com/1/cards/${cardId}`,
    null,
    { params: { idList: targetListId, key, token } }
  );
}

// =======================================================
// 🔥 WEBHOOK ENTRY (DEBOUNCE)
// =======================================================
app.post("/webhook", (req, res) => {
  res.sendStatus(200);

  const action = req.body?.action;
  if (!action || action.type !== "updateCheckItemStateOnCard") return;

  const cardId = action.data.card.id;

  // 🔥 debounce ต่อ card
  if (debounceMap.has(cardId)) {
    clearTimeout(debounceMap.get(cardId));
  }

  debounceMap.set(
    cardId,
    setTimeout(() => processWebhook(req.body), DEBOUNCE_MS)
  );
});

// =======================================================
// 🔥 CORE LOGIC
// =======================================================
async function processWebhook(body) {
  try {
    const action = body.action;

    const cardId = action.data.card.id;
    const itemId = action.data.checkItem.id;
    const state = action.data.checkItem.state;
    const isComplete = state === "complete";

    // 🔥 loop guard
    const last = ignoreMap.get(itemId);
    if (last && Date.now() - last < IGNORE_TTL) {
      console.log("🛑 ignore loop");
      return;
    }

    console.log("📩", cardId, itemId, state);

    // ===================================================
    // 1. LOAD STEP
    // ===================================================
    const { data: step } = await supabase
      .from("steps")
      .select("*")
      .eq("trello_item_id", itemId)
      .maybeSingle();

    if (!step) return;

    const { data: all } = await supabase
      .from("steps")
      .select("*")
      .eq("job_id", step.job_id);

    const parents = all
      .filter(s => !s.parent_id)
      .sort((a, b) => a.step_order - b.step_order);

    const getSubs = (id) => all.filter(s => s.parent_id === id);

    const parent = step.parent_id
      ? all.find(x => x.id === step.parent_id)
      : step;

    const parentIndex = parents.findIndex(p => p.id === parent.id);
    const lastDoneIndex = parents.findLastIndex(p => p.status === "done");

    const subs = getSubs(parent.id);
    const hasSub = subs.length > 0;

    // ===================================================
    // 🔥 RULE 1: parent with sub → block
    // ===================================================
    if (!step.parent_id && hasSub && isComplete) {
      await revert(cardId, itemId, "incomplete");
      return;
    }

    // ===================================================
    // 🔥 RULE 2: forward skip
    // ===================================================
    if (!step.parent_id && isComplete && parentIndex !== lastDoneIndex + 1) {
      await revert(cardId, itemId, "incomplete");
      return;
    }

    // ===================================================
    // 🔥 RULE 3: backward skip
    // ===================================================
    if (!step.parent_id && !isComplete && parentIndex !== lastDoneIndex) {
      await revert(cardId, itemId, "complete");
      return;
    }

    // ===================================================
    // 2. UPDATE STEP
    // ===================================================
    await supabase
      .from("steps")
      .update({
        status: isComplete ? "done" : "pending",
      })
      .eq("id", step.id);

    // ===================================================
    // 🔥 SUBSTEP LOGIC
    // ===================================================
    if (step.parent_id) {
      const freshSubs = getSubs(parent.id);
      const allDone = freshSubs.every(s => s.status === "done");

      // sync parent
      await supabase
        .from("steps")
        .update({
          status: allDone ? "done" : "pending",
        })
        .eq("id", parent.id);

      await revert(
        cardId,
        parent.trello_item_id,
        allDone ? "complete" : "incomplete"
      );

      // 🔥 MOVE BASED ON PARENT
      const target = allDone
        ? parents[parentIndex + 1]
        : parents[parentIndex];

      if (target?.trello_list_id) {
        await moveCard(cardId, target.trello_list_id);
      }

      await updateProgress(itemId);
      return;
    }

    // ===================================================
    // 🔥 PARENT MOVE
    // ===================================================
    const target = isComplete
      ? parents[parentIndex + 1]
      : parents[parentIndex];

    if (target?.trello_list_id) {
      await moveCard(cardId, target.trello_list_id);
    }

    await updateProgress(itemId);

  } catch (err) {
    console.error("ERR:", err.message);
  }
}

// =======================================================
app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 running");
});
