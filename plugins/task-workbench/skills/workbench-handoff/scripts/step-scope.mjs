// Date: 2026-11-17. Resolve subtree ownership without granting excluded work to a previous chat.
export function stepInScope(steps, key, roots, excluded = []) {
  const byKey = new Map(steps.map(step => [step.key, step]));
  const lineage = new Set();
  for (let current = byKey.get(key); current && !lineage.has(current.key); current = byKey.get(current.parentKey)) lineage.add(current.key);
  return roots.some(root => lineage.has(root)) && !excluded.some(root => lineage.has(root));
}

export function bindingOwnsStep(snapshot, binding, step) {
  return stepInScope(snapshot.steps, typeof step === 'string' ? step : step.key, binding.stepKeys, binding.excludedStepKeys ?? []);
}
