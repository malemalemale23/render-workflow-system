import { Worker } from "bullmq";
import IORedis from "ioredis";
import axios from "axios";
import supabase from "../config/db.js";

const connection = new IORedis(process.env.REDIS_URL);

const worker = new Worker(
  "workflow",
  async (job) => {
    const { cardId, boardId, itemId, state } = job.data;

    console.log("🔥 PROCESS JOB:", cardId);

    // 👉 เอา logic webhook เดิมของคุณมาใส่ตรงนี้ทั้งหมด
    // เช่น:
    // 1. load step จาก DB
    // 2. enforce rules
    // 3. update DB
    // 4. move card

  },
  { connection }
);

worker.on("completed", job => {
  console.log("✅ done:", job.id);
});

worker.on("failed", (job, err) => {
  console.error("❌ fail:", err.message);
});
