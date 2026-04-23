import { ENV } from "../config/env.js";

const connection = new IORedis(ENV.redis);

import express from "express";


import { workflowQueue } from "./queue/queue.js";
import { createJobWithSteps } from "./services/createJob.js";


const app = express();
app.use(express.json());

// ===== BASE ROUTES =====
app.get("/", (_, res) => {
  res.send("Workflow system running 🚀");
});

// ===== TRELLO WEBHOOK VERIFY =====
app.get("/webhook", (_, res) => {
  res.send("ok");
});

// =======================================================
// 🔥 WEBHOOK → PUSH TO QUEUE
// =======================================================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // ⚠️ ตอบทันที ห้าม await อะไรนาน

  try {
    const action = req.body?.action;

    // รับเฉพาะ event ติ๊ก checklist
    if (!action || action.type !== "updateCheckItemStateOnCard") {
      return;
    }

    const cardId = action.data.card.id;
    const boardId = action.data.board.id;
    const itemId = action.data.checkItem.id;
    const state = action.data.checkItem.state;

    console.log("📩 webhook:", cardId, itemId, state);

    // =======================================================
    // 🚀 PUSH JOB เข้า queue
    // =======================================================
    await workflowQueue.add(
      "process-checklist",
      {
        cardId,
        boardId,
        itemId,
        state
      },
      {
        jobId: `${cardId}`, // 🔥 dedupe ต่อ card
        removeOnComplete: true,
        removeOnFail: true,
        delay: 100 // 🔥 กัน click รัว
      }
    );

  } catch (err) {
    console.error("Webhook error:", err.message);
  }
});

app.post("/create-job", async (req, res) => {
  try {
    const result = await createJobWithSteps(req.body);
    res.json(result);
  } catch (err) {
    console.error("CREATE JOB ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
