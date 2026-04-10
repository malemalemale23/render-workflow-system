import supabase from "../config/db.js";

export async function createSteps(jobId, steps) {
  const results = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    const { data: parent, error } = await supabase
      .from("steps")
      .insert({
        job_id: jobId,
        name: step.name,
        step_order: i + 1,
        status: "pending",
      })
      .select()
      .single();

    if (error) {
      console.error("STEP INSERT ERROR:", error);
      throw error;
    }

    if (!parent) {
      throw new Error("Parent step insert failed");
    }

    results.push(parent);

    if (step.substeps) {
      for (let j = 0; j < step.substeps.length; j++) {
        const sub = step.substeps[j];

        await supabase.from("steps").insert({
          job_id: jobId,
          parent_id: parent.id,
          name: sub.name,
          step_order: j + 1,
          status: "pending",
        });
      }
    }
  }

  return results;
}
