import supabase from "../config/db.js";

export async function updateProgress(itemId) {
  // หา step
  const { data: step } = await supabase
    .from("steps")
    .select("*")
    .eq("trello_item_id", itemId)
    .single();

  if (!step || !step.parent_id) return;

  // หา substeps ทั้งหมด
  const { data: subs } = await supabase
    .from("steps")
    .select("*")
    .eq("parent_id", step.parent_id);

  const done = subs.filter(s => s.status === "done").length;
  const total = subs.length;

  const progress = total === 0 ? 0 : done / total;

  console.log("PROGRESS:", progress);

  // update parent
  await supabase
    .from("steps")
    .update({ progress })
    .eq("id", step.parent_id);


  if (progress === 1) {
    const { data: parent } = await supabase
      .from("steps")
      .select("trello_item_id")
      .eq("id", step.parent_id)
      .single();

    await fetch(
      `https://api.trello.com/1/cards/${parent.trello_item_id}/checkItem/${parent.trello_item_id}?state=complete&key=${process.env.TRELLO_KEY}&token=${process.env.TRELLO_TOKEN}`,
      { method: "PUT" }
    );
  }
}
