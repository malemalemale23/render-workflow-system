export async function createSteps(jobId, steps, cardId) {
  const results = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    const { data: parent } = await supabase
      .from("steps")
      .insert({
        job_id: jobId,
        card_id: cardId, // 🔥 เพิ่ม
        name: step.name,
        step_order: i + 1,
        status: "pending",
        trello_list_id: step.trello_list_id // 🔥 เพิ่ม
      })
      .select()
      .single();

    results.push(parent);

    if (step.substeps) {
      for (let j = 0; j < step.substeps.length; j++) {
        const sub = step.substeps[j];

        await supabase.from("steps").insert({
          job_id: jobId,
          card_id: cardId, // 🔥 เพิ่ม
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
