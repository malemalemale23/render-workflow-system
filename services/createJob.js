import supabase from "../config/db.js";
import { createCard, createChecklist, addChecklistItem } from "./trello.js";

export async function createJobWithSteps(body) {
  const { name, listId, job, steps } = body;

  if (!name || !listId || !job || !steps) {
    throw new Error("missing required fields");
  }

  console.log("🔥 CREATE JOB START");

  // 1. create card
  const card = await createCard(name, listId);
  console.log("✅ card:", card.id);

  // 2. create job
  const { data: jobRow, error: jobError } = await supabase
    .from("jobs")
    .insert({
      po_number: job.po_number,
      customer: job.customer,
    })
    .select()
    .single();

  if (jobError) throw jobError;

  // 3. checklist
  const checklist = await createChecklist(card.id, "Workflow");
  console.log("✅ checklist:", checklist.id);

  // 4. steps
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    console.log("👉 parent:", step.name);

    const { data: parent, error: parentErr } = await supabase
      .from("steps")
      .insert({
        job_id: jobRow.id,
        card_id: card.id,
        name: step.name,
        step_order: i + 1,
        status: "pending",
        trello_list_id: step.trello_list_id,
      })
      .select()
      .single();

    if (parentErr) throw parentErr;

    const parentItem = await addChecklistItem(checklist.id, step.name);

    if (!parentItem?.id) {
      throw new Error("❌ parentItem create fail");
    }

    await supabase
      .from("steps")
      .update({ trello_item_id: parentItem.id })
      .eq("id", parent.id);

    // ===============================
    // 🔥 SUBSTEP (FIX จริง)
    // ===============================
    if (step.substeps && step.substeps.length > 0) {
      console.log("   🔽 substeps found:", step.substeps.length);

      for (let j = 0; j < step.substeps.length; j++) {
        const sub = step.substeps[j];

        console.log("   👉 sub:", sub.name);

        // 1. DB
        const { data: subRow, error: subErr } = await supabase
          .from("steps")
          .insert({
            job_id: jobRow.id,
            card_id: card.id,
            parent_id: parent.id,
            name: sub.name,
            step_order: j + 1,
            status: "pending",
          })
          .select()
          .single();

        if (subErr) throw subErr;

        // 2. Trello
        const subItem = await addChecklistItem(
          checklist.id,
          `- ${sub.name}`
        );

        if (!subItem?.id) {
          throw new Error("❌ subItem create fail");
        }

        // 3. map
        await supabase
          .from("steps")
          .update({ trello_item_id: subItem.id })
          .eq("id", subRow.id);
      }
    }
  }

  console.log("🔥 CREATE JOB DONE");

  return {
    success: true,
    cardId: card.id,
    jobId: jobRow.id,
  };
}