import supabase from "../config/db.js";
import { createCard, createChecklist, addChecklistItem } from "./trello.js";

export async function createJobWithSteps(body) {
  const { name, listId, job, steps } = body;

  if (!name || !listId || !job || !steps) {
    throw new Error("missing required fields");
  }

  // ===================================================
  // 1. CREATE CARD
  // ===================================================
  const card = await createCard(name, listId);

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

  if (jobError) throw jobError;

  // ===================================================
  // 3. CREATE CHECKLIST
  // ===================================================
  const checklist = await createChecklist(card.id, "Workflow");

  // ===================================================
  // 4. CREATE STEPS
  // ===================================================
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // 🔥 parent DB
    const { data: parent } = await supabase
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

    // 🔥 parent checklist
    const parentItem = await addChecklistItem(
      checklist.id,
      step.name
    );

    await supabase
      .from("steps")
      .update({ trello_item_id: parentItem.id })
      .eq("id", parent.id);

    // 🔥 substeps
    if (step.substeps) {
      for (let j = 0; j < step.substeps.length; j++) {
        const sub = step.substeps[j];

        const subItem = await addChecklistItem(
          checklist.id,
          `(${sub.name})`
        );

        await supabase
          .from("steps")
          .insert({
            job_id: jobRow.id,
            card_id: card.id,
            parent_id: parent.id,
            name: sub.name,
            step_order: j + 1,
            status: "pending",
            trello_item_id: subItem.id
          });
      }
    }
  }

  return {
    success: true,
    cardId: card.id,
    jobId: jobRow.id
  };
}
