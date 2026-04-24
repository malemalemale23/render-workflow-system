import dotenv from "dotenv";
dotenv.config();

import express from "express";
import axios from "axios";
import IORedis from "ioredis";
import { Queue, Worker } from "bullmq";

import supabase from "./config/db.js";
import { updateProgress } from "./services/progressService.js";
import { createJobWithSteps } from "./services/createJob.js";

// =======================================================
// 🔥 ENV CHECK
// =======================================================
if (!process.env.REDIS_URL) {
  console.error("❌ REDIS_URL missing");
  process.exit(1);
}

console.log("REDIS_URL =>", process.env.REDIS_URL);

// =======================================================
// 🔥 REDIS
// =======================================================
const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

connection.on("connect", () => {
  console.log("✅ Redis connected");
});

connection.on("error", (err) => {
  console.log("❌ Redis error:", err.message);
});

// =======================================================
// 🔥 QUEUE
// =======================================================
const workflowQueue = new Queue("workflow", { connection });

// =======================================================
// 🔥 EXPRESS
// =======================================================
const app = express();
app.use(express.json());

app.get("/", (_, res) => {
  res.send("Workflow system running 🚀");
});

// =======================================================
// 🔥 WEBHOOK
// =======================================================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // ต้องตอบเร็ว

  try {
    const action = req.body?.action;
    if (!action || action.type !== "updateCheckItemStateOnCard") return;

    const cardId = action.data.card.id;
    const itemId = action.data.checkItem.id;
    const state = action.data.checkItem.state;

    console.log("📩 webhook:", cardId, itemId, state);

    await workflowQueue.add(
      "process",
      { cardId, itemId, state },
      {
        jobId: `${cardId}`, // dedupe ต่อ card
        removeOnComplete: true,
        removeOnFail: true,
        delay: 100,
      }
    );

  } catch (err) {
    console.error("Webhook error:", err.message);
  }
});

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
// 🔥 TRELLO HELPERS
// =======================================================
const key = process.env.TRELLO_KEY;
const token = process.env.TRELLO_TOKEN;

async function revert(cardId, itemId, state) {
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
// 🔥 WORKER (CORE LOGIC)
// =======================================================
new Worker(
  "workflow",
  async (job) => {
    const { cardId, itemId, state } = job.data;
    console.log("🔥 JOB:", cardId, itemId, state);

    const isComplete = state === "complete";

    // =======================================================
    // 1. LOAD STEP
    // =======================================================
    const { data: step } = await supabase
      .from("steps")
      .select("*")
      .eq("trello_item_id", itemId)
      .single();

    if (!step) return;

    // =======================================================
    // 2. UPDATE CURRENT STEP
    // =======================================================
    await supabase
      .from("steps")
      .update({
        status: isComplete ? "done" : "pending",
      })
      .eq("id", step.id);

    // =======================================================
    // 3. SUBSTEP LOGIC
    // =======================================================
    let parentStep = step;

    if (step.parent_id) {
      // load parent
      const { data: parent } = await supabase
        .from("steps")
        .select("*")
        .eq("id", step.parent_id)
        .single();

      if (!parent) return;

      parentStep = parent;

      // 🔥 load subs FRESH (แก้ bug สำคัญ)
      const { data: subs } = await supabase
        .from("steps")
        .select("*")
        .eq("parent_id", parent.id);

      const allDone = subs.every(s => s.status === "done");

      // update parent
      await supabase
        .from("steps")
        .update({
          status: allDone ? "done" : "pending",
        })
        .eq("id", parent.id);

      // sync trello parent
      await revert(
        cardId,
        parent.trello_item_id,
        allDone ? "complete" : "incomplete"
      );

      // ❌ ถ้ายังไม่ครบ ห้าม move
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

    // ❌ parent มี sub ห้ามติ๊กเอง
    if (!step.parent_id && hasSub && isComplete) {
      await revert(cardId, itemId, "incomplete");
      return;
    }

    // ❌ forward ต้องเรียง
    if (isComplete && index !== lastDoneIndex + 1) {
      await revert(cardId, itemId, "incomplete");
      return;
    }

    // ❌ backward ต้องเรียง
    if (!isComplete && index !== lastDoneIndex) {
      await revert(cardId, itemId, "complete");
      return;
    }

    // =======================================================
    // 6. PROGRESS
    // =======================================================
    try {
      await updateProgress(itemId);
    } catch {}

    // =======================================================
    // 7. MOVE CARD
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
  },
  {
    connection,
    concurrency: 1,
  }
);

// =======================================================
app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Server running");
});
