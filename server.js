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

// ===== CACHE =====
let cachedLists = null;
let lastFetch = 0;
const CACHE_TTL = 60000;

// ===== BASE ROUTES =====
app.get("/", (_, res) => res.send("OK"));
app.get("/webhook", (_, res) => res.send("ok"));

// ===== WEBHOOK =====
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // 🔥 always respond first

  console.log("1. webhook hit");

  const action = req.body?.action;
  if (!action || action.type !== "updateCheckItemStateOnCard") {
    console.log("2. skip action");
    return;
  }

  const cardId = action.data.card.id;
  const boardId = action.data.board.id;
  const itemId = action.data.checkItem.id;
  const state = action.data.checkItem.state;

  console.log("CLICK:", itemId, state);

  // ===== 🔒 REDIS LOCK (SAFE) =====
  try {
    if (redis) {
      const lockKey = `lock:${cardId}`;
      const locked = await redis.get(lockKey);
      if (locked) {
        console.log("LOCKED");
        return;
      }
      await redis.set(lockKey, "1", "PX", 1000);
    }
  } catch (e) {
    console.error("Redis skip:", e.message);
  }

  // ===== 🔥 STEP 1: DB LOGIC (SAFE) =====
  let step = null;

  try {
    const { data, error } = await supabase
      .from("steps")
      .select("*")
      .eq("trello_item_id", itemId)
      .maybeSingle();

    if (error) throw error;
    step = data;

    if (step) {
      console.log("STEP:", step.name);

      // ❌ BLOCK parent
      if (!step.parent_id && state === "complete") {
        const { data: subs } = await supabase
          .from("steps")
          .select("*")
          .eq("parent_id", step.id);

        const allDone = subs?.every(s => s.status === "done");

        if (!allDone) {
          console.log("❌ BLOCK parent");

          await axios.put(
            `https://api.trello.com/1/cards/${cardId}/checkItem/${itemId}`,
            null,
            { params: { state: "incomplete", key, token } }
          );
          return;
        }
      }

      // ✅ update status
      await supabase
        .from("steps")
        .update({
          status: state === "complete" ? "done" : "pending"
        })
        .eq("trello_item_id", itemId);

      // ✅ update progress (SAFE)
      try {
        await updateProgress(itemId);
      } catch (e) {
        console.error("Progress fail:", e.message);
      }
    } else {
      console.log("No step found");
    }

  } catch (e) {
    console.error("DB fail:", e.message);
  }

  // ===== 🔥 STEP 2: TRELO LOGIC (ALWAYS RUN) =====
  try {
    console.log("Fetch checklist");

    const { data } = await axios.get(
      `https://api.trello.com/1/cards/${cardId}/checklists`,
      { params: { key, token } }
    );

    const items = data.flatMap(c => c.checkItems);
    if (!items.length) return;

    let lastChecked = -1;
    for (let i = 0; i < items.length; i++) {
      if (items[i].state === "complete") lastChecked = i;
    }

    // ❌ RULE 1
    for (let i = 1; i < items.length; i++) {
      if (items[i].state === "complete" && items[i - 1].state !== "complete") {
        await axios.put(
          `https://api.trello.com/1/cards/${cardId}/checkItem/${items[i].id}`,
          null,
          { params: { state: "incomplete", key, token } }
        );
        return;
      }
    }

    // ❌ RULE 2
    for (let i = 0; i < items.length; i++) {
      if (items[i].state === "incomplete") {
        const hasCheckedAfter = items
          .slice(i + 1)
          .some(x => x.state === "complete");

        if (hasCheckedAfter) {
          await axios.put(
            `https://api.trello.com/1/cards/${cardId}/checkItem/${items[i].id}`,
            null,
            { params: { state: "complete", key, token } }
          );
          return;
        }
        break;
      }
    }

    // ===== TARGET =====
    const columnName =
      lastChecked === -1
        ? items[0].name
        : lastChecked < items.length - 1
        ? items[lastChecked + 1].name
        : items[lastChecked].name;

    if (!columnName) return;

    // ===== CACHE =====
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

    const currentListId = action.data.listAfter?.id;
    if (currentListId === target.id) return;

    console.log("MOVE CARD");

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
    console.error("Trello logic fail:", e.message);
  }
});

// ===== START =====
app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
