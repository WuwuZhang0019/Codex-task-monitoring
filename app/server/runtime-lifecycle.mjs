// Date: 2026-11-18. Blocked task checkpoints survive exit without representing active work.
export function runtimeExitStatus(snapshot, runs = []) {
  const byKey = new Map((snapshot?.steps ?? []).map(step => [step.key, step]));
  const executions = (snapshot?.executions ?? []).filter(item => {
    if (item.endedAt || item.outcome !== 'running') return false;
    // Retain protection for missing/ambiguous scope; only explicit blocked checkpoints are idle.
    return !item.stepKeys?.length
      || !item.stepKeys.some(key => byKey.get(key)?.status === 'blocked')
      || !item.stepKeys.every(key => ['blocked', 'completed', 'cancelled'].includes(byKey.get(key)?.status));
  });
  const steps = (snapshot?.steps ?? []).filter(item => item.status === 'running');
  const continuous = runs.filter(item => ['running', 'pausing'].includes(item.status));
  return { allowed: !executions.length && !steps.length && !continuous.length,
    activeExecutions: executions.length, runningSteps: steps.length, continuousRuns: continuous.length };
}
