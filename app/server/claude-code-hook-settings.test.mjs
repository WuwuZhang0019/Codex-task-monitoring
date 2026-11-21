import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { CLAUDE_CODE_HOOK_URL } from './claude-cli-monitor.mjs';
import { createClaudeCodeHookSettings } from './claude-code-hook-settings.mjs';
import { createServer, HttpError } from './index.mjs';

const legacyHook = timeout => ({ hooks: [{ type: 'http', url: CLAUDE_CODE_HOOK_URL, timeout }] });

async function fixture(t, receiver = { listening: true, lastEventAt: null, error: null }) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'claude-code-hook-settings-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const configDir = path.join(temp, 'profile');
  await mkdir(configDir);
  const file = path.join(configDir, 'settings.json');
  return { file, settings: createClaudeCodeHookSettings({ configDir, receiverStatus: () => receiver }) };
}

test('reuses the legacy task island callbacks and keeps the existing provider, model and user hooks', async t => {
  const { file, settings } = await fixture(t);
  const profile = {
    env: { ANTHROPIC_BASE_URL: 'https://provider.example', ANTHROPIC_AUTH_TOKEN: 'fake-token' },
    model: 'user-model',
    modelSettings: { 'user-model': { effort: 'high' } },
    statusLine: { type: 'command', command: 'user-status-line' },
    hooks: {
      Notification: [legacyHook(3)], PermissionRequest: [legacyHook(600)],
      PostToolUse: [legacyHook(3), { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-tool-hook' }] }],
      PreToolUse: [legacyHook(3)], SessionEnd: [legacyHook(3)], SessionStart: [legacyHook(3)],
      Stop: [legacyHook(3)], UserPromptSubmit: [legacyHook(3)],
    },
  };
  await writeFile(file, '\uFEFF' + JSON.stringify(profile), 'utf8');
  const status = await settings.read();
  assert.equal(status.listening, true);
  assert.equal(status.configured, false);
  assert.deepEqual(status.missingEvents, ['PostToolUseFailure', 'StopFailure']);
  assert.equal(JSON.stringify(status).includes('fake-token'), false);

  const [first, repeat] = await Promise.all([settings.install(), settings.install()]);
  assert.equal(first.changed, true);
  assert.equal(first.configured, true);
  assert.equal(first.receiver.lastEventAt, null);
  assert.equal(repeat.changed, false);
  const contents = await readFile(file, 'utf8');
  assert.deepEqual(JSON.parse(contents), {
    ...profile, hooks: { ...profile.hooks, PostToolUseFailure: [legacyHook(3)], StopFailure: [legacyHook(3)] },
  });
  assert.equal((await settings.install()).changed, false);
  assert.equal(await readFile(file, 'utf8'), contents);
});

test('installs only missing notification types, including coverage from existing explicit matchers', async t => {
  const { file, settings } = await fixture(t);
  const group = { matcher: '^permission_prompt$', ...legacyHook(3) };
  await writeFile(file, JSON.stringify({ allowedHttpHookUrls: ['http://127.0.0.1:*/claude/hook'], hooks: { Notification: [group] } }));
  assert.equal((await settings.install()).configured, true);
  const { hooks } = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(hooks.Notification, [group, { matcher: 'idle_prompt', ...legacyHook(3) }]);
  assert.equal(hooks.SessionStart, undefined);
  assert.equal(hooks.PermissionRequest, undefined);
});

test('a stopped receiver, malformed settings and existing hook policies leave files untouched', async t => {
  const stopped = await fixture(t, { listening: false, lastEventAt: null, error: 'EADDRINUSE' });
  const status = await stopped.settings.read();
  assert.equal(status.listening, false);
  assert.equal(status.receiver.error, 'EADDRINUSE');
  await assert.rejects(stopped.settings.install(), /未监听/);
  await assert.rejects(readFile(stopped.file), { code: 'ENOENT' });

  const { file, settings } = await fixture(t);
  for (const [input, error] of [
    ['{"hooks":', /有效的 JSON/],
    ['{"disableAllHooks":true}', /已停用/],
    ['{"allowedHttpHookUrls":["https://example.test/*"]}', /白名单/],
  ]) {
    await writeFile(file, input, 'utf8');
    await assert.rejects(settings.install(), error);
    assert.equal(await readFile(file, 'utf8'), input);
  }
  await rm(file);
  assert.equal((await settings.install()).configured, true);
});

test('the private owner API installs hooks while the legacy receiver has no management route', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'claude-code-hook-admin-'));
  const configDir = path.join(temp, 'profile');
  const authorization = 'Bearer owner-fixture';
  const server = await createServer({
    dataDir: path.join(temp, 'data'),
    env: {},
    lightAccessEnabled: true,
    claudeCliHooks: { port: 0 },
    claudeCodeConfigDir: configDir,
    authorize(req) {
      if (req.headers.authorization !== authorization) throw new HttpError(403, 'FORBIDDEN');
    },
  });
  t.after(async () => {
    await server.claudeCliHooks.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(temp, { recursive: true, force: true });
  });
  await Promise.all([
    new Promise(resolve => server.listen(0, '127.0.0.1', resolve)),
    server.claudeCliHooks.start(),
  ]);
  const route = '/api/claude-code/hooks';
  const owner = `http://127.0.0.1:${server.address().port}${route}`;
  const receiver = `http://127.0.0.1:${server.claudeCliHooks.address().port}${route}`;
  const request = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' };
  const file = path.join(configDir, 'settings.json');
  assert.equal((await fetch(receiver, request)).status, 404);
  assert.equal((await fetch(owner, request)).status, 403);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  request.headers.Authorization = authorization;
  const installed = await fetch(owner, request);
  assert.equal(installed.status, 200);
  assert.equal((await installed.json()).changed, true);
  const read = await fetch(owner, { headers: { Authorization: authorization } });
  const status = await read.json();
  assert.equal(status.configured, true);
  assert.equal(status.listening, true);
  assert.equal(status.receiver.lastEventAt, null);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).hooks.Stop[0].hooks[0].url, CLAUDE_CODE_HOOK_URL);
});
