// Date: 2026-11-17. Exit protection distinguishes paused checkpoints from active work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeExitStatus } from './runtime-lifecycle.mjs';

test('active steps, unknown execution scope and draining continuous runs remain protected', () => {
  assert.equal(runtimeExitStatus(null).allowed, true);
  assert.equal(runtimeExitStatus({ steps: [{ status: 'running' }] }).allowed, false);
  assert.equal(runtimeExitStatus({ executions: [{ outcome: 'running', endedAt: null }] }).allowed, false);
  for (const status of ['running', 'pausing']) assert.equal(runtimeExitStatus(null, [{ status }]).allowed, false);
  assert.equal(runtimeExitStatus({ executions: [{ outcome: 'completedScope', endedAt: '2026-11-16' }] }, [{ status: 'paused' }]).allowed, true);
});

test('blocked executions permit exit without ending or clearing their checkpoints', () => {
  const snapshot = {
    steps: [{ key: 'I', status: 'blocked' }, { key: 'I-04', status: 'blocked' }],
    executions: [{ outcome: 'running', endedAt: null, stepKeys: ['I', 'I-04'] }],
  };
  const before = structuredClone(snapshot);
  assert.deepEqual(runtimeExitStatus(snapshot, [{ status: 'paused' }]), {
    allowed: true, activeExecutions: 0, runningSteps: 0, continuousRuns: 0,
  });
  assert.deepEqual(snapshot, before);
  assert.equal(runtimeExitStatus(snapshot, [{ status: 'pausing' }]).allowed, false);
});

test('one blocked step cannot hide a running or missing step in the same execution', () => {
  for (const status of ['running', 'pending', undefined]) {
    const steps = [{ key: 'I', status: 'blocked' }];
    if (status) steps.push({ key: 'I-04', status });
    const snapshot = { steps, executions: [{ outcome: 'running', endedAt: null, stepKeys: ['I', 'I-04'] }] };
    assert.equal(runtimeExitStatus(snapshot).allowed, false);
  }
});
