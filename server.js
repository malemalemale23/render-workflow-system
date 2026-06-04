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

// =====================================================
// LOOP GUARD
// =====================================================
const ignoreMap = new Map();

function ignore(id) {
  ignoreMap.set(id, Date.now() + 2000);
}

function isIgnored(id) {
  const exp = ignoreMap.get(id);

  if (!exp) return false;

  if (Date.now() > exp) {
    ignoreMap.delete(id);
    return false;
  }

  return true;
}

// =====================================================
// HELPERS
// =====================================================
async function trelloSet(cardId, itemId, state) {
  ignore(itemId);

  console.log("🔁 set:", itemId, state);

  await axios.put(
    `https://api.trello.com/1/cards/${cardId}/checkItem/${itemId}`,
    null,
    {
      params: {
        state,
        key,
        token,
      },
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
        token,
      },
    }
  );

  if (card.idList === listId) return;

  console.log("🚀 MOVE:", listId);

  await axios.put(
    `https://api.trello.com/1/cards/${cardId}`,
    null,
    {
      params: {
        idList: listId,
        key,
        token,
      },
    }
  );
}

// =====================================================
// CREATE JOB
// =====================================================
app.post("/create-job", async (req, res) => {
  try {
    const result = await createJobWithSteps(req.body);
    res.json(result);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: err.message,
    });
  }
});

// =====================================================
// WEBHOOK
// =====================================================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const action = req.body?.action;

    if (!action) return;

    if (action.type !== "updateCheckItemStateOnCard") return;

    const cardId = action.data.card.id;
    const itemId = action.data.checkItem.id;
    const isComplete =
      action.data.checkItem.state === "complete";

    if (isIgnored(itemId)) {
      console.log("🛑 ignored");
      return;
    }

    console.log("📩", itemId, isComplete);

    // =================================================
    // LOAD STEP
    // =================================================
    const { data: step } = await supabase
      .from("steps")
      .select("*")
      .eq("trello_item_id", itemId)
      .single();

    if (!step) return;

    // =================================================
    // LOAD ALL
    // =================================================
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

    // =================================================
    // FIND CURRENT STEP
    // =================================================
    let currentIndex = 0;

    for (let i = 0; i < parents.length; i++) {
      if (parents[i].status === "done") {
        currentIndex = i + 1;
      } else {
        break;
      }
    }

    // =================================================
    // ❌ USER CLICK PARENT WITH SUBSTEP
    // =================================================
    if (
      !step.parent_id &&
      hasSubsteps
    ) {
      await trelloSet(
        cardId,
        itemId,
        step.status === "done"
          ? "complete"
          : "incomplete"
      );

      return;
    }

    // =================================================
    // ❌ BLOCK FUTURE STEP
    // =================================================
    if (
      isComplete &&
      parentIndex > currentIndex
    ) {
      await trelloSet(
        cardId,
        itemId,
        "incomplete"
      );

      return;
    }

    // =================================================
    // ❌ BLOCK OLD UNCHECK
    // =================================================
    if (
      !isComplete &&
      !step.parent_id &&
      parentIndex !== currentIndex - 1
    ) {
      await trelloSet(
        cardId,
        itemId,
        "complete"
      );

      return;
    }

    // ❌ substep check ได้เฉพาะ current step
    if (
      step.parent_id &&
      isComplete &&
      parentIndex !== currentIndex
    ) {
      await trelloSet(cardId, itemId, "incomplete");
      return;
    }

    // ❌ substep uncheck ได้เฉพาะ parent ล่าสุด
    if (
      step.parent_id &&
      !isComplete &&
      parentIndex !== currentIndex - 1
    ) {
      await trelloSet(cardId, itemId, "complete");
      return;
    }

    // // ❌ substep uncheck ได้เฉพาะ parent ล่าสุด
    // if (
    //   step.parent_id &&
    //   !isComplete &&
    //   parentIndex !== currentIndex - 1
    // ) {
    //   await trelloSet(cardId, itemId, "complete");
    //   return;
    // }

    // =================================================
    // UPDATE CURRENT STEP
    // =================================================
    await supabase
      .from("steps")
      .update({
        status: isComplete
          ? "done"
          : "pending",
      })
      .eq("id", step.id);

    // =================================================
    // SUBSTEP FLOW
    // =================================================
    if (step.parent_id) {

      // reload fresh
      const { data: freshSubs } = await supabase
        .from("steps")
        .select("*")
        .eq("parent_id", parent.id);

      const allDone = freshSubs.every(
        x => x.status === "done"
      );

      // =============================================
      // AUTO CHECK / UNCHECK PARENT
      // =============================================

      const newParentStatus = allDone
        ? "done"
        : "pending";

      // update db
      await supabase
        .from("steps")
        .update({
          status: newParentStatus,
        })
        .eq("id", parent.id);

      // sync trello เฉพาะตอน state เปลี่ยนจริง
      if (parent.status !== newParentStatus) {

        await trelloSet(
          cardId,
          parent.trello_item_id,
          allDone
            ? "complete"
            : "incomplete"
        );

      }
        // =============================================
        // MOVE CARD
        // =============================================
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

    // =================================================
    // NORMAL PARENT FLOW
    // =================================================
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
    console.error("ERR:", err.message);
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 running");
});