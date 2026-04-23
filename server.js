import express from "express";
import axios from "axios";
import Redis from "ioredis";
import dotenv from "dotenv";

import supabase from "./config/db.js";
import { updateProgress } from "./services/progressService.js";

dotenv.config();

const app = express();
app.use(express.json());

// ===== ENV =====
const key = process.env.TRELLO_KEY;
const token = process.env.TRELLO_TOKEN;

// ===== REDIS SAFE INIT =====
let redis = null;
try {
  redis = new Redis(process.env.REDIS_URL);
  redis.on("error", (err) => {
    console.error("Redis error:", err.message);
  });
} catch (e) {
  console.error("Redis init fail");
}

// ===== CACHE LIST =====
let cachedLists = null;
let lastFetch = 0;
const CACHE_TTL = 60000;

// ===== BASE ROUTES =====
app.get("/", (_, res) => res.send("Workflow system running"));
app.get("/webhook", (_, res) => res.send("ok"));


// =======================================================
// 🔥 MAIN WEBHOOK
// =======================================================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // ⚠️ ต้องตอบทันที

  const action = req.body?.action;
  if (!action || action.type !== "updateCheckItemStateOnCard") return;

  const cardId = action.data.card.id;
  const boardId = action.data.board.id;
  const itemId = action.data.checkItem.id;
  const state = action.data.checkItem.state;

  console.log("CLICK:", itemId, state);

  // ===== REDIS LOCK =====
  try {
    if (redis) {
      const lockKey = `lock:${cardId}`;
      const locked = await redis.get(lockKey);
      if (locked) return;
      await redis.set(lockKey, "1", "PX", 500);
    }
  } catch (e) {
    console.log("Redis skip");
  }

  // =======================================================
  // 🔥 STEP 1: DB LOGIC
  // =======================================================
  let step = null;

  try {
    const { data, error } = await supabase
      .from("steps")
      .select("*")
      .eq("trello_item_id", itemId)
      .maybeSingle();

    if (error) throw error;
    step = data;

    if (!step) return;

    // ============================
    // ✅ SUBSTEP LOGIC
    // ============================
    if (step.parent_id) {

      // update substep
      await supabase
        .from("steps")
        .update({
          status: state === "complete" ? "done" : "pending"
        })
        .eq("id", step.id);

      // check siblings
      const { data: subs } = await supabase
        .from("steps")
        .select("*")
        .eq("parent_id", step.parent_id);

      const allDone = subs.every(s => s.status === "done");

      // get parent
      const { data: parent } = await supabase
        .from("steps")
        .select("*")
        .eq("id", step.parent_id)
        .single();

      if (!parent) return;

      // 🔥 sync parent state
      await axios.put(
        `https://api.trello.com/1/cards/${cardId}/checkItem/${parent.trello_item_id}`,
        null,
        {
          params: {
            state: allDone ? "complete" : "incomplete",
            key,
            token
          }
        }
      );

      // 🔥 update parent DB
      await supabase
        .from("steps")
        .update({
          status: allDone ? "done" : "pending"
        })
        .eq("id", parent.id);
    }

    // ============================
    // ✅ PARENT LOGIC
    // ============================
    else {

      // ❌ block ถ้า substep ยังไม่ครบ
      if (state === "complete") {
        const { data: subs } = await supabase
          .from("steps")
          .select("*")
          .eq("parent_id", step.id);

        if (subs.length > 0) {
          const allDone = subs.every(s => s.status === "done");

          if (!allDone) {
            console.log("❌ BLOCK parent");

            await axios.put(
              `https://api.trello.com/1/cards/${cardId}/checkItem/${itemId}`,
              null,
              {
                params: {
                  state: "incomplete",
                  key,
                  token
                }
              }
            );
            return;
          }
        }
      }

      // update parent
      await supabase
        .from("steps")
        .update({
          status: state === "complete" ? "done" : "pending"
        })
        .eq("id", step.id);
    }

    // ============================
    // 🔥 UPDATE PROGRESS
    // ============================
    try {
      await updateProgress(itemId);
    } catch (e) {
      console.log("progress skip");
    }

  } catch (e) {
    console.error("DB FAIL:", e.message);
  }


  // =======================================================
  // 🔥 STEP 2: MOVE CARD BASED ON PROGRESS
  // =======================================================
  try {

    const { data: parents } = await supabase
      .from("steps")
      .select("*")
      .eq("card_id", cardId)
      .is("parent_id", null)
      .order("step_order", { ascending: true });

    if (!parents || parents.length === 0) return;

    let lastDoneIndex = -1;

    for (let i = 0; i < parents.length; i++) {
      if (parents[i].status === "done") {
        lastDoneIndex = i;
      } else {
        break;
      }
    }

    const targetStep =
      lastDoneIndex === -1
        ? parents[0]
        : lastDoneIndex < parents.length - 1
        ? parents[lastDoneIndex + 1]
        : parents[lastDoneIndex];

    if (!targetStep) return;

    const columnName = targetStep.name;

    // ===== fetch lists =====
    if (!cachedLists || Date.now() - lastFetch > CACHE_TTL) {
      const { data: lists } = await axios.get(
        `https://api.trello.com/1/boards/${boardId}/lists`,
        { params: { key, token } }
      );
      cachedLists = lists;
      lastFetch = Date.now();
    }

    const target = cachedLists.find(l => l.name === columnName);
    if (!target) return;

    console.log("MOVE →", columnName);

    await axios.put(
      `https://api.trello.com/1/cards/${cardId}`,
      null,
      {
        params: {
          idList: target.id,
          key,
          token
        }
      }
    );

  } catch (e) {
    console.error("MOVE FAIL:", e.message);
  }
});


// ===== START SERVER =====
app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
