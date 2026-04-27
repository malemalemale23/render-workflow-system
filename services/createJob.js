import supabase from "../config/db.js";
import {
  createCard,
  createChecklist,
  addChecklistItem
} from "./trello.js";

export async function createJobWithSteps(body) {
  const { name, listId, job, steps } = body;

  console.log("📥 create job:", body);

  if (!name || !listId || !job || !steps || !steps.length) {
    throw new Error("missing required fields");
  }

  // ===================================================
  // 1. CREATE CARD
  // ===================================================
  const card = await createCard(name, listId);
  console.log("✅ card:", card.id);

  // ===================================================
  // 2. CREATE JOB
  // ===================================================
  const { data: jobRow, error: jobError } = await supabase
    .from("jobs")
    .insert({
      po_number: job.po_number,
      customer: job.customer
    })
    .select()
    .single();

  if (jobError) {
    console.error("❌ job error:", jobError);
    throw jobError;
  }

  console.log("✅ job:", jobRow.id);

  // ===================================================
  // 3. CREATE CHECKLIST
  // ===================================================
  const checklist = await createChecklist(card.id, "Workflow");

  // ===================================================
  // 4. CREATE STEPS
  // ===================================================
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    console.log("👉 step:", step.name);

    if (!step.trello_list_id) {
      throw new Error(`missing trello_list_id: ${step.name}`);
    }

    // ✅ insert parent
    const { data: parent, error: parentError } = await supabase
      .from("steps")
      .insert({
        job_id: jobRow.id,
        card_id: card.id,
        name: step.name,
        step_order: i + 1,
        status: "pending",
        trello_list_id: step.trello_list_id
      })
      .select()
      .single();

    if (parentError) {
      console.error("❌ parent insert error:", parentError);
      throw parentError;
    }

    console.log("✅ parent:", parent.id);

    // ✅ create checklist item (parent)
    const item = await addChecklistItem(checklist.id, step.name);

    // map
    await supabase
      .from("steps")
      .update({ trello_item_id: item.id })
      .eq("id", parent.id);

    // ===================================================
    // 🔥 SUBSTEPS
    // ===================================================
    if (step.substeps && step.substeps.length) {
      for (let j = 0; j < step.substeps.length; j++) {
        const sub = step.substeps[j];

        console.log("   ↳ sub:", sub.name);

        // ✅ insert substep
        const { data: subRow, error: subError } = await supabase
          .from("steps")
          .insert({
            job_id: jobRow.id,
            card_id: card.id,
            parent_id: parent.id,
            name: sub.name,
            step_order: j + 1,
            status: "pending"
          })
          .select()
          .single();

        if (subError) {
          console.error("❌ sub insert error:", subError);
          throw subError;
        }

        // ✅ create checklist item (sub)
        const subItem = await addChecklistItem(
          checklist.id,
          `- ${sub.name}`
        );

        await supabase
          .from("steps")
          .update({ trello_item_id: subItem.id })
          .eq("id", subRow.id);
      }
    }
  }

  console.log("🎉 DONE");

  return {
    success: true,
    jobId: jobRow.id,
    cardId: card.id
  };
}
