import supabase from "../config/db.js";
import { createCard, createChecklist, addChecklistItem } from "./trello.js";

export async function createJobWithSteps(body) {
  const { name, listId, job, steps } = body;

  if (!name || !listId || !job || !steps) {
    throw new Error("missing required fields");
  }

  // =======================================================
  // 1. CREATE CARD (Trello)
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
  // 4. CREATE STEPS + MAP
  // =======================================================
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // 🔥 create parent step
    const { data: parent, error: stepError } = await supabase
      .from("steps")
      .insert({
        job_id: jobRow.id,
        card_id: card.id, // 🔥 สำคัญ
        name: step.name,
        step_order: i + 1,
        status: "pending",
        trello_list_id: step.trello_list_id // 🔥 สำคัญ
      })
      .select()
      .single();

    if (stepError) throw stepError;

    // 🔥 create checklist item
    const item = await addChecklistItem(checklist.id, step.name);

    // 🔥 map trello_item_id
    await supabase
      .from("steps")
      .update({ trello_item_id: item.id })
      .eq("id", parent.id);

    // 🔥 substeps
    if (step.substeps) {
      for (let j = 0; j < step.substeps.length; j++) {
        const sub = step.substeps[j];

        await supabase
          .from("steps")
          .insert({
            job_id: jobRow.id,
            card_id: card.id,
            parent_id: parent.id,
            name: sub.name,
            step_order: j + 1,
            status: "pending"
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
