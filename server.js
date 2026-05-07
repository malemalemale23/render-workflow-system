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

// ======================================================
// LOOP GUARD
// ======================================================
const ignoreMap = new Map();

function markIgnore(id) {
  ignoreMap.set(id, Date.now() + 1500);
}

function isIgnored(id) {
  const t = ignoreMap.get(id);

  if (!t) return false;

  if (Date.now() > t) {
    ignoreMap.delete(id);
    return false;
  }

  return true;
}

// ======================================================
// BASIC
// ======================================================
app.get("/", (_, res) => {
  res.send("workflow running");
});

// ======================================================
// CREATE JOB
// ======================================================
app.post("/create-job", async (req, res) => {
  try {
    const result = await createJobWithSteps(req.body);
    res.json(result);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: err.message
    });
  }
});

// ======================================================
// HELPERS
// ======================================================
async function revert(cardId, itemId, state) {
  markIgnore(itemId);

  console.log("↩️ revert:", itemId, state);

  await axios.put(
    `https://api.trello.com/1/cards/${cardId}/checkItem/${itemId}`,
    null,
    {
      params: {
        state,
        key,
        token
      }
    }
  );
}

async function syncParent(cardId, itemId, state) {
  markIgnore(itemId);

  console.log("🔁 sync:", itemId, state);

  await axios.put(
    `https://api.trello.com/1/cards/${cardId}/checkItem/${itemId}`,
    null,
    {
      params: {
        state,
        key,
        token
      }
    }
  );
}

async function moveCard(cardId, listId) {
  const { data: card } = await axios.get(
    `https://api.trello.com/1/cards/${cardId}`,
    {
      params: {
        fields: "idList",
        key,
        token
      }
    }
  );

  if (card.idList === listId) {
    return;
  }

  console.log("🚀 MOVE →", listId);

  await axios.put(
    `https://api.trello.com/1/cards/${cardId}`,
    null,
    {
      params: {
        idList: listId,
        key,
        token
      }
    }
  );
}

// ======================================================
// WEBHOOK
// ======================================================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const action = req.body?.action;

    if (!action) return;

    if (action.type !== "updateCheckItemStateOnCard") {
      return;
    }

    const cardId = action.data.card.id;
    const itemId = action.data.checkItem.id;

    const isComplete =
      action.data.checkItem.state === "complete";

    // ==================================================
    // LOOP GUARD
    // ==================================================
    if (isIgnored(itemId)) {
      console.log("🛑 ignore loop");
      return;
    }

    console.log("📩", itemId, isComplete);

    // ==================================================
    // LOAD CURRENT STEP
    // ==================================================
    const { data: step } = await supabase
      .from("steps")
      .select("*")
      .eq("trello_item_id", itemId)
      .single();

    if (!step) {
      console.log("step not found");
      return;
    }

    // ==================================================
    // LOAD ALL STEPS
    // ==================================================
    const { data: all } = await supabase
      .from("steps")
      .select("*")
      .eq("job_id", step.job_id);

    const parents = all
      .filter(x => !x.parent_id)
      .sort((a, b) => a.step_order - b.step_order);

    const parent = step.parent_id
      ? all.find(x => x.id === step.parent_id)
      : step;

    const substeps = all.filter(
      x => x.parent_id === parent.id
    );

    const hasSubsteps = substeps.length > 0;

    const parentIndex = parents.findIndex(
      x => x.id === parent.id
    );

    // ==================================================
    // FIND CURRENT ACTIVE STEP
    // ==================================================
    let currentIndex = 0;

    for (let i = 0; i < parents.length; i++) {
      if (parents[i].status === "done") {
        currentIndex = i + 1;
      } else {
        break;
      }
    }

    // ==================================================
    // VALIDATION
    // ==================================================

    // ❌ future step
    if (isComplete && parentIndex > currentIndex) {
      await revert(cardId, itemId, "incomplete");
      return;
    }

    // ❌ old step uncheck
    if (
      !isComplete &&
      !step.parent_id &&
      parentIndex !== currentIndex - 1
    ) {
      await revert(cardId, itemId, "complete");
      return;
    }

    // ❌ parent with substep cannot manual check
    if (!step.parent_id && hasSubsteps) {
      await revert(
        cardId,
        itemId,
        step.status === "done"
          ? "complete"
          : "incomplete"
      );

      return;
    }

    // ❌ substep only current parent
    if (
      step.parent_id &&
      parentIndex !== currentIndex
    ) {
      await revert(
        cardId,
        itemId,
        isComplete
          ? "incomplete"
          : "complete"
      );

      return;
    }

    // ==================================================
    // UPDATE CURRENT STEP
    // ==================================================
    await supabase
      .from("steps")
      .update({
        status: isComplete
          ? "done"
          : "pending"
      })
      .eq("id", step.id);

    // ==================================================
    // SUBSTEP FLOW
    // ==================================================
    if (step.parent_id) {

      // reload fresh subs
      const { data: freshSubs } = await supabase
        .from("steps")
        .select("*")
        .eq("parent_id", parent.id);

      const allDone = freshSubs.every(
        x => x.status === "done"
      );

      // ================================================
      // UPDATE PARENT STATUS
      // ================================================
      await supabase
        .from("steps")
        .update({
          status: allDone
            ? "done"
            : "pending"
        })
        .eq("id", parent.id);

      // ================================================
      // AUTO CHECK / UNCHECK PARENT
      // ================================================
      await syncParent(
        cardId,
        parent.trello_item_id,
        allDone
          ? "complete"
          : "incomplete"
      );

      // ================================================
      // MOVE CARD
      // ================================================
      const targetIndex = allDone
        ? parentIndex + 1
        : parentIndex;

      const target =
        parents[targetIndex] ||
        parents[parentIndex];

      if (target?.trello_list_id) {
        await moveCard(
          cardId,
          target.trello_list_id
        );
      }

      return;
    }

    // ==================================================
    // NORMAL PARENT FLOW
    // ==================================================
    const targetIndex = isComplete
      ? parentIndex + 1
      : parentIndex;

    const target =
      parents[targetIndex] ||
      parents[parentIndex];

    if (target?.trello_list_id) {
      await moveCard(
        cardId,
        target.trello_list_id
      );
    }

  } catch (err) {
    console.error("WEBHOOK ERR:", err.message);
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 running");
});