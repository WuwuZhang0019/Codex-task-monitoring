// Date: 2026-11-16. Exit protection is independent of UI visibility and MCP heartbeats.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeExitStatus } from './runtime-lifecycle.mjs';

test('only idle state permits exit; open blocked executions and draining continuous runs remain protected', () => {
  assert.equal(runtimeExitStatus(null).allowed, true);
  assert.equal(runtimeExitStatus({ steps: [{ status: 'running' }] }).allowed, false);
  assert.equal(runtimeExitStatus({ executions: [{ outcome: 'running', endedAt: null }] }).allowed, false);
  for (const status of ['running', 'pausing']) assert.equal(runtimeExitStatus(null, [{ status }]).allowed, false);
  assert.equal(runtimeExitStatus({ executions: [{ outcome: 'completedScope', endedAt: '2026-11-16' }] }, [{ status: 'paused' }]).allowed, true);
});
