import axios from "axios";
import supabase from "../config/db.js";

const key = process.env.TRELLO_KEY;
const token = process.env.TRELLO_TOKEN;

export async function updateProgress(itemId) {
  const { data: step } = await supabase
    .from("steps")
    .select("*")
    .eq("trello_item_id", itemId)
    .single();

  if (!step || !step.parent_id) return;

  const { data: subs } = await supabase
    .from("steps")
    .select("*")
    .eq("parent_id", step.parent_id);

  const done = subs.filter(s => s.status === "done").length;
  const total = subs.length;

  const progress = total === 0 ? 0 : done / total;

  console.log("PROGRESS:", progress);

  await supabase
    .from("steps")
    .update({ progress })
    .eq("id", step.parent_id);

  // 🔥 auto check parent
  if (progress === 1) {
    const { data: parent } = await supabase
      .from("steps")
      .select("trello_item_id, card_id")
      .eq("id", step.parent_id)
      .single();

    if (!parent?.card_id || !parent?.trello_item_id) return;

    await axios.put(
      `https://api.trello.com/1/cards/${parent.card_id}/checkItem/${parent.trello_item_id}`,
      null,
      {
        params: {
          state: "complete",
          key,
          token
        }
      }
    );
  }
}
