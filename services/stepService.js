export async function createSteps(jobId, steps, cardId) {
  const results = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    if (!step.trello_list_id) {
      throw new Error(`Missing trello_list_id for step: ${step.name}`);
    }

    const { data: parent, error } = await supabase
      .from("steps")
      .insert({
        job_id: jobId,
        card_id: cardId,
        name: step.name,
        step_order: i + 1,
        status: "pending",
        trello_list_id: step.trello_list_id
      })
      .select()
      .single();

    if (error) {
      console.error("PARENT INSERT ERROR:", error);
      throw error;
    }

    results.push(parent);

    if (step.substeps) {
      for (let j = 0; j < step.substeps.length; j++) {
        const sub = step.substeps[j];

        const { error: subError } = await supabase
          .from("steps")
          .insert({
            job_id: jobId,
            card_id: cardId,
            parent_id: parent.id,
            name: sub.name,
            step_order: j + 1,
            status: "pending",
          });

        if (subError) {
          console.error("SUBSTEP ERROR:", subError);
          throw subError;
        }
      }
    }
  }

  return results;
}
