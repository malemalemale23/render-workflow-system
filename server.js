import dotenv from "dotenv";
dotenv.config();

import express from "express";
import axios from "axios";
import supabase from "./config/db.js";

const app = express();
app.use(express.json());

// =======================================================
// 🔥 ENV
// =======================================================
const key = process.env.TRELLO_KEY;
const token = process.env.TRELLO_TOKEN;

// =======================================================
// 🔥 HELPERS
// =======================================================

async function revert(cardId, itemId, state) {
  await axios.put(
    `https://api.trello.com/1/cards/${cardId}/checkItem/${itemId}`,
    null,
    { params: { state, key, token } }
  );
}

// 🔥 revert + STOP
async function revertAndBlock(cardId, itemId, state) {
  await revert(cardId, itemId, state);
  console.log("⛔ BLOCK");
  return true;
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
// 🔥 BASE
// =======================================================
app.get("/", (_, res) => {
  res.send("Workflow running 🚀");
});

// =======================================================
// 🔥 WEBHOOK
// =======================================================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // ต้องเร็ว

  try {
    const action = req.body?.action;
    if (!action || action.type !== "updateCheckItemStateOnCard") return;

    const cardId = action.data.card.id;
    const itemId = action.data.checkItem.id;
    const state = action.data.checkItem.state;
    const isComplete = state === "complete";

    console.log("📩", cardId, itemId, state);

    // =======================================================
    // 1. LOAD STEP
    // =======================================================
    const { data: step } = await supabase
      .from("steps")
      .select("*")
      .eq("trello_item_id", itemId)
      .maybeSingle();

    if (!step) return;

    // =======================================================
    // 2. UPDATE CURRENT STEP
    // =======================================================
    await supabase
      .from("steps")
      .update({
        status: isComplete ? "done" : "pending"
      })
      .eq("id", step.id);

    let parentStep = step;

    // =======================================================
    // 3. SUBSTEP LOGIC
    // =======================================================
    if (step.parent_id) {
      const { data: parent } = await supabase
        .from("steps")
        .select("*")
        .eq("id", step.parent_id)
        .single();

      parentStep = parent;

      const { data: subs } = await supabase
        .from("steps")
        .select("*")
        .eq("parent_id", parent.id);

      const allDone = subs.every(s => s.status === "done");

      // update parent status
      await supabase
        .from("steps")
        .update({
          status: allDone ? "done" : "pending"
        })
        .eq("id", parent.id);

      // sync parent trello
      await revert(
        cardId,
        parent.trello_item_id,
        allDone ? "complete" : "incomplete"
      );

      // ❌ ยังไม่ครบ → BLOCK MOVE
      if (!allDone) return;
    }

    // =======================================================
    // 4. LOAD ALL PARENTS
    // =======================================================
    const { data: allSteps } = await supabase
      .from("steps")
      .select("*")
      .eq("job_id", parentStep.job_id);

    const parents = allSteps
      .filter(s => !s.parent_id)
      .sort((a, b) => a.step_order - b.step_order);

    const index = parents.findIndex(p => p.id === parentStep.id);
    if (index === -1) return;

    const lastDoneIndex = parents.findLastIndex(p => p.status === "done");

    const hasSub = allSteps.some(s => s.parent_id === parentStep.id);

    // =======================================================
    // 5. RULE ENGINE
    // =======================================================

    // ❌ parent มี sub ห้าม user check เอง
    if (!step.parent_id && hasSub && isComplete) {
      if (await revertAndBlock(cardId, itemId, "incomplete")) return;
    }

    // ❌ forward skip
    if (isComplete && index !== lastDoneIndex + 1) {
      if (await revertAndBlock(cardId, itemId, "incomplete")) return;
    }

    // ❌ backward skip
    if (!isComplete && index !== lastDoneIndex) {
      if (await revertAndBlock(cardId, itemId, "complete")) return;
    }

    // =======================================================
    // 6. MOVE CARD (ONLY VALID CASE)
    // =======================================================
    const targetIndex = isComplete ? index + 1 : index - 1;

    const clamped = Math.max(
      0,
      Math.min(targetIndex, parents.length - 1)
    );

    const target = parents[clamped];

    if (!target?.trello_list_id) {
      console.log("❌ missing trello_list_id");
      return;
    }

    await moveCard(cardId, target.trello_list_id);

  } catch (err) {
    console.error("❌ webhook error:", err.message);
  }
});

// =======================================================
app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Server running");
});
