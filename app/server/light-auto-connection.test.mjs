// Date: 2026-11-12. Automatic association retains Git, revision, revocation and execution checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPersistence } from './persistence.mjs';
import { createRequests } from './business-requests.mjs';
import { createLightAccess } from './light-access.mjs';
import { createLightService } from './light-service.mjs';
import { prepareLightPlan } from './light-import.mjs';
import { createServer, HttpError } from './index.mjs';
import { createLightBridge } from '../mcp/light-bridge.mjs';

test('automatic desktop connection has expiring, per-session Codex presence and immediate revocation', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'light-auto-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistence = await createPersistence(root);
  let now = Date.parse('2026-11-12T08:00:00+08:00');
  const access = createLightAccess(persistence, { now: () => now, presenceTtlMs: 100 });
  await assert.rejects(async () => access.connect({ acknowledged: false }), /INVALID_INPUT/);
  const { principal } = await access.connect({ acknowledged: true });
  const status = () => access.connectionStatus({ principal, acknowledged: true });
  assert.equal(status().enabled, true);
  assert.equal(status().connected, false, 'saved authorization is not an MCP connection');
  const first = { 'x-workbench-client': 'codex-mcp-client', 'x-workbench-session': randomUUID() };
  const second = { ...first, 'x-workbench-session': randomUUID() };
  access.touch(principal, { ...first, 'x-workbench-client': 'other-client' });
  assert.equal(status().connected, false, 'another MCP client must not be called Codex');
  access.touch(principal, first); access.touch(principal, second);
  assert.equal(status().connected, true);
  access.touch(principal, { ...first, 'x-workbench-presence': 'offline' });
  assert.equal(status().connected, true, 'closing one of two Codex sessions preserves the other');
  now += 101;
  assert.equal(status().connected, false, 'stale heartbeats expire');
  assert.ok(status().lastSeenAt, 'keep last contact for the disconnected description');
  access.touch(principal, second);
  assert.equal(status().connected, true, 'a resumed heartbeat restores the connection');
  await access.revoke({ principal, acknowledged: true });
  assert.equal(status().connected, false); assert.equal(status().enabled, false);
  assert.equal(access.authorize(principal, 'any-project', 'read'), false);
});

test('automatic binding verifies real Git, commits once, permits progress, and rejects invalid branches and revoked access', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'light-auto-bind-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worktree = path.join(root, 'worktree'); await mkdir(worktree);
  const git = (...args) => execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim();
  git('init', '-b', 'main'); git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
  const persistence = await createPersistence(path.join(root, 'data'));
  const access = createLightAccess(persistence);
  const grant = await access.connect({ acknowledged: true });
  const service = createLightService(persistence, createRequests(persistence), {
    authorize: access.authorize, confirmBinding: access.verifyBinding,
    automaticBinding: access.automaticBinding, verifyExecutionContext: access.verifyExecutionContext,
  });
  const context = { sessionGroup: 'A', threadId: 'real-chat-id', hostId: 'local', folderId: null,
    worktreeOrdinal: 1, worktreePath: worktree, branch: 'main', head: git('rev-parse', 'HEAD'), trust: 'declared' };
  const sourcePath = new URL('../../docs/03_轻量路线工作台/03_测试样例/01_模拟二十步骤与六分支工作树_测试文档_2026-11-10.md', import.meta.url);
  const candidate = prepareLightPlan({ text: await readFile(sourcePath, 'utf8'), sourcePath: sourcePath.pathname,
    version: 'auto-test', projectKey: 'auto/project', planKey: 'auto/plan', name: 'Automatic binding fixture', date: '2026-11-12', context });
  const principal = grant.principal;
  const registered = await service.register(principal, { eventId: 'register', expectedRevision: 0, snapshot: candidate });
  const projectId = registered.projectId, planId = registered.planIds[0];
  const source = Object.fromEntries(Object.entries(candidate.plans[0].source).filter(([key]) => key !== 'trust'));
  const read = () => service.read(principal, projectId);
  const base = eventId => ({ schemaVersion: 'light-1.0', projectId, planId, expectedRevision: read().projects[0].revision,
    eventId, source, occurredAt: '2026-11-12T08:00:00+08:00', reason: 'Automatic binding regression' });
  const step = read().steps[0];
  const propose = { ...base('auto-bind'), action: 'propose', stepIds: [step.id], context,
    bindingId: null, expectedBindingRevision: null, confirmationGrant: null };
  const bound = await service.bind(principal, propose);
  assert.equal(bound.state, 'confirmed', 'one tool call binds without a separate UI confirmation');
  assert.deepEqual(await service.bind(principal, propose), bound);
  const before = read();
  await assert.rejects(service.bind(principal, { ...propose, ...base('wrong-branch'), context: { ...context, branch: 'wrong' } }), /STALE_BINDING/);
  assert.deepEqual(read(), before, 'a failed automatic verification does not commit a proposal');
  await assert.rejects(async () => service.bind(principal, { ...propose, ...base('remote-host'), context: { ...context, hostId: 'remote' } }), /FORBIDDEN/);
  const subdirectory = path.join(worktree, 'subdirectory'); await mkdir(subdirectory);
  await assert.rejects(service.bind(principal, { ...propose, ...base('not-root'), context: { ...context, worktreePath: subdirectory } }), /STALE_BINDING/);
  const reserved = await service.reserveExecutionId(principal, base('reserve'));
  const start = { ...base('start'), stepId: step.id, executionId: reserved.executionId, bindingId: bound.bindingId,
    bindingRevision: bound.bindingRevision, targetStatus: 'running', evidence: [], checks: [], blocker: null, reopen: null, successorImpact: null };
  await service.update(principal, start);
  await access.revoke({ principal, acknowledged: true });
  await assert.rejects(service.update(principal, { ...start, eventId: 'after-revoke' }), /FORBIDDEN/);
});

test('initialized SDK and real STDIO transports produce Codex status, idle leases renew, and close disconnects', { timeout: 15000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'light-auto-transport-'));
  const ownerToken = 'a'.repeat(64);
  const server = await createServer({ dataDir: root, env: {}, lightAccessEnabled: true, lightPresence: { presenceTtlMs: 150 },
    authorize(req, pathname) {
      if (pathname !== '/api/light-mcp' && req.headers.authorization !== `Bearer ${ownerToken}`) throw new HttpError(403, 'FORBIDDEN');
    } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, body, token = ownerToken) => {
    const response = await fetch(`${endpoint}/api/light-access/${route}`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  };
  const { value: grant } = await post('connect', { acknowledged: true });
  const status = async () => (await post('connection-status', { principal: grant.principal, acknowledged: true })).value;
  assert.equal((await status()).connected, false);
  const configFile = path.join(root, 'bridge-config.json');
  const stdio = new Client({ name: 'codex-mcp-client', version: 'stdio-test' });
  t.after(() => stdio.close());
  await stdio.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../mcp/light-stdio.mjs', import.meta.url))],
    env: { WORKBENCH_LIGHT_CONFIG: configFile }, stderr: 'pipe' }));
  assert.equal((await stdio.listTools()).tools.length, 9, 'a fresh installation discovers tools while awaiting the desktop button');
  assert.equal((await status()).connected, false);
  await writeFile(configFile, JSON.stringify({ endpoint, token: grant.token }), { mode: 0o600 });
  await stdio.listTools();
  assert.equal((await status()).connected, true, 'the packaged STDIO entry forwards initialized Codex identity');
  await stdio.close();
  for (let attempt = 0; attempt < 30 && (await status()).connected; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await status()).connected, false, 'abrupt STDIO exit expires even without a graceful offline message');
  assert.equal((await post('connect', { acknowledged: true }, grant.token)).status, 403, 'plugin cannot mint a management grant');
  const bridge = createLightBridge({ endpoint, token: grant.token }, { presenceIntervalMs: 30 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'codex-mcp-client', version: 'test' });
  t.after(async () => { await client.close(); await bridge.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  await bridge.connect(b); await client.connect(a); await client.listTools();
  assert.equal((await status()).connected, true);
  const lastSeen = (await status()).lastSeenAt;
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.ok((await status()).lastSeenAt > lastSeen, 'an idle initialized client renews its lease');
  await client.close();
  for (let attempt = 0; attempt < 30 && (await status()).connected; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await status()).connected, false);
});
