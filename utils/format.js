export function formatStep(step, i, j) {
  if (j) {
    return `   - ${step.name}`; // 👈 indent substep
  }
  return step.name;
}
