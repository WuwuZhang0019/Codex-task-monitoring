// Date: 2026-11-16. Exit decisions use committed task state, never client presence alone.
export function runtimeExitStatus(snapshot, runs = []) {
  const executions = (snapshot?.executions ?? []).filter(item => !item.endedAt && item.outcome === 'running');
  const steps = (snapshot?.steps ?? []).filter(item => item.status === 'running');
  const continuous = runs.filter(item => ['running', 'pausing'].includes(item.status));
  return { allowed: !executions.length && !steps.length && !continuous.length,
    activeExecutions: executions.length, runningSteps: steps.length, continuousRuns: continuous.length };
}
