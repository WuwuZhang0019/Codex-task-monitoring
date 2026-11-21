import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer, HttpError } from './index.mjs';

async function workbench(t, port = 0) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'workbench-claude-cli-'));
  let server;
  t.after(async () => {
    if (server) {
      await server.claudeCliHooks.close();
      await new Promise(resolve => server.close(resolve));
    }
    await rm(dataDir, { recursive: true, force: true });
  });
  server = await createServer({ dataDir, env: {}, lightAccessEnabled: true, claudeCliHooks: { port },
    authorize(req) {
      if (req.headers.authorization !== 'Bearer owner') throw new HttpError(403, 'FORBIDDEN');
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  await server.claudeCliHooks.start();
  return server;
}

test('Claude Code hooks report separate observed sessions without accessing the private API', async t => {
  const server = await workbench(t);
  const root = `http://127.0.0.1:${server.address().port}`;
  const receiver = `http://127.0.0.1:${server.claudeCliHooks.address().port}`;
  const panel = async () => {
    const response = await fetch(root + '/api/light-panel', { headers: { Authorization: 'Bearer owner' } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const post = (payload, headers) => fetch(receiver + '/claude/hook', { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload) });
  async function event(sessionId, hookEventName, details) {
    const response = await post({ session_id: sessionId, hook_event_name: hookEventName, ...details });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
  }
  async function status(sessionId) {
    return (await panel()).claudeCliSessions.find(item => item.sessionId === sessionId)?.status;
  }

  assert.equal(server.claudeCliHooks.status().lastEventAt, null);
  assert.equal((await fetch(root + '/api/light-panel')).status, 403);
  assert.equal((await fetch(receiver + '/api/light-panel', { headers: { Authorization: 'Bearer owner' } })).status, 404);
  assert.equal((await fetch(receiver + '/claude/hook')).status, 405);
  assert.equal((await post({ session_id: 'ignored', hook_event_name: 'Stop' }, { Origin: root })).status, 403);
  const forgedHostStatus = await new Promise((resolve, reject) => {
    const req = http.get(receiver + '/claude/hook', { headers: { Host: 'example.test' } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    req.once('error', reject);
  });
  assert.equal(forgedHostStatus, 403);
  assert.equal((await post({ hook_event_name: 'PreToolUse' })).status, 400);

  await event('one', 'UserPromptSubmit', { cwd: 'G:\\workspace', prompt_id: 'turn-1', prompt: 'do not keep this', transcript_path: 'private.jsonl' });
  assert.equal(await status('one'), 'running');
  await event('one', 'SessionStart', { source: 'startup' });
  assert.equal(await status('one'), 'running', 'late startup callback must not reset a running turn');
  await event('one', 'PermissionRequest');
  assert.equal(await status('one'), 'running');
  await event('one', 'Notification', { notification_type: 'auth_success', message: 'permission' });
  assert.equal(await status('one'), 'running', 'notification text is never used to guess permission state');
  await event('one', 'PreToolUse', { prompt_id: 'turn-1', tool_input: { command: 'private tool input' } });
  await event('one', 'Notification', { notification_type: 'permission_prompt' });
  assert.equal(await status('one'), 'waitingApproval');
  await event('two', 'UserPromptSubmit', { cwd: 'G:\\workspace' });
  assert.equal(await status('two'), 'running');
  assert.equal(await status('one'), 'waitingApproval');
  await event('one', 'PostToolUse', { prompt_id: 'turn-1' });
  assert.equal(await status('one'), 'running');
  await event('one', 'Stop', { prompt_id: 'turn-1' });
  await event('one', 'PostToolUse', { prompt_id: 'turn-1' });
  assert.equal(await status('one'), 'turnEnded');
  await event('one', 'PreToolUse', { prompt_id: 'turn-1' });
  assert.equal(await status('one'), 'running', 'a Stop hook may have asked Claude to continue');
  await event('one', 'UserPromptSubmit', { prompt_id: 'turn-2' });
  await event('one', 'Stop', { prompt_id: 'turn-1' });
  assert.equal(await status('one'), 'running');
  await event('two', 'Stop');
  await event('two', 'Notification', { notification_type: 'idle_prompt' });
  assert.equal(await status('two'), 'waitingInput');
  await event('one', 'SessionEnd');
  await event('one', 'PreToolUse');
  assert.equal(await status('one'), 'ended');
  assert.equal(await status('two'), 'waitingInput');
  await event('one', 'SessionStart', { source: 'resume' });
  assert.equal(await status('one'), 'waitingInput');

  const snapshot = await panel();
  assert.equal(snapshot.claudeCliSessions.length, 2);
  assert.equal(snapshot.claudeCliSessions.find(item => item.sessionId === 'one').cwd, 'G:\\workspace');
  assert.deepEqual(snapshot.snapshot.plans, []);
  assert.doesNotMatch(JSON.stringify(snapshot), /do not keep|private.jsonl|private tool input/);
  assert.ok(server.claudeCliHooks.status().lastEventAt);
});

test('unavailable hook port does not prevent the authorized workbench from starting', async t => {
  const existing = http.createServer();
  t.after(() => new Promise(resolve => existing.close(resolve)));
  existing.listen(0, '127.0.0.1');
  await once(existing, 'listening');
  const server = await workbench(t, existing.address().port);
  assert.deepEqual(server.claudeCliHooks.status(), { listening: false, lastEventAt: null, error: 'EADDRINUSE' });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/light-panel`, { headers: { Authorization: 'Bearer owner' } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).claudeCliSessions, []);
});
