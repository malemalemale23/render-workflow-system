import supabase from "../config/db.js";
import { createCard, createChecklist, addChecklistItem } from "../services/trello.js";
import { createSteps } from "../services/stepService.js";
import { formatStep } from "../utils/format.js";

export async function createJob(req, res) {
  try {
    const { poNumber, steps } = req.body;

    
    // 1. create job
    const { data: job, error: jobError } = await supabase
        .from("jobs")
        .upsert({ po_number: poNumber })
        .select()
        .single();

    if (jobError) {
    console.error("JOB ERROR:", jobError);
    throw jobError;
    }

    if (!job) {
    throw new Error("Job insert failed");
    }

    console.log("job:", job);
    //clean db
    // await supabase
    //     .from("steps")
    //     .delete()
    //     .eq("job_id", job.id);

    // 2. create steps in DB
    const parentSteps = await createSteps(job.id, steps);

    // 3. create Trello card
    const card = await createCard(poNumber, process.env.TRELLO_LIST_ID);

    // 4. create checklist
    const checklist = await createChecklist(card.id, "ขั้นตอน");

    // 5. create checklist items
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      const parentItem = await addChecklistItem(
        checklist.id,
        formatStep(step, i + 1)
      );

      // save mapping
      await supabase
        .from("steps")
        .update({ 
          trello_item_id: parentItem.id,
          card_id: card.id
        })
        .eq("job_id", job.id)
        .eq("step_order", i + 1)
        .is("parent_id", null);

      if (step.substeps) {
        for (let j = 0; j < step.substeps.length; j++) {
          const sub = step.substeps[j];

          const subItem = await addChecklistItem(
            checklist.id,
            formatStep(sub, i + 1, j + 1)
          );

        await supabase
          .from("steps")
          .update({ trello_item_id: subItem.id })
          .eq("job_id", job.id)
          .eq("parent_id", parentSteps[i].id)
          .eq("step_order", j + 1);

        }
      }
    }

    res.json({ success: true, job });
  } catch (err) {
  console.error("ERROR:", err.response?.data || err.message || err);
  res.status(500).send("error");
}

}
