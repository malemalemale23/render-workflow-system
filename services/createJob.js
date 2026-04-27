import supabase from "../config/db.js";
import { createCard, createChecklist, addChecklistItem } from "./trello.js";

export async function createJobWithSteps(body) {
  const { name, listId, job, steps } = body;

  if (!name || !listId || !job || !steps) {
    throw new Error("missing required fields");
  }

  // =======================================================
  // 1. CREATE CARD
  // =======================================================
  const card = await createCard(name, listId);

  // =======================================================
  // 2. CREATE JOB (DB)
  // =======================================================
  const { data: jobRow, error: jobError } = await supabase
    .from("jobs")
    .insert({
      po_number: job.po_number,
      customer: job.customer
    })
    .select()
    .single();

  if (jobError) throw jobError;

  // =======================================================
  // 3. CREATE CHECKLIST
  // =======================================================
  const checklist = await createChecklist(card.id, "Workflow");

  // =======================================================
  // 4. CREATE STEPS + SUBSTEPS
  // =======================================================
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    if (!step.trello_list_id) {
      throw new Error(`Missing trello_list_id for step: ${step.name}`);
    }

    // 🔥 create parent step
    const { data: parent, error: parentError } = await supabase
      .from("steps")
      .insert({
        job_id: jobRow.id,
        card_id: card.id,
        name: step.name,
        step_order: i + 1,
        status: "pending",
        trello_list_id: parent.trello_list_id
      })
      .select()
      .single();

    if (parentError) throw parentError;

    // 🔥 create parent checklist item
    const parentItem = await addChecklistItem(checklist.id, step.name);

    // 🔥 map trello_item_id → parent
    await supabase
      .from("steps")
      .update({
        trello_item_id: parentItem.id
      })
      .eq("id", parent.id);

    // ===================================================
    // 🔥 SUBSTEPS
    // ===================================================
    if (step.substeps && step.substeps.length > 0) {
      for (let j = 0; j < step.substeps.length; j++) {
        const sub = step.substeps[j];

        // 🔥 create substep in DB
        const { data: subRow, error: subError } = await supabase
          .from("steps")
          .insert({
            job_id: jobRow.id,
            card_id: card.id,
            parent_id: parent.id,
            name: sub.name,
            step_order: j + 1,
            status: "pending",
            trello_list_id: parent.trello_list_id
          })
          .select()
          .single();

        if (subError) throw subError;

        // 🔥 create checklist item for substep
        const subItem = await addChecklistItem(
          checklist.id,
          `${step.name} - ${sub.name}`
        );

        // 🔥 map trello_item_id → substep
        await supabase
          .from("steps")
          .update({
            trello_item_id: subItem.id
          })
          .eq("id", subRow.id);
      }
    }
  }

  return {
    success: true,
    jobId: jobRow.id,
    cardId: card.id
  };
}
