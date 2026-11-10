// 日期 2026-11-11。真实 STDIO 子进程通过私有 HTTP 所有者访问独立持久目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server/index.mjs';
import { HttpError } from '../server/validation.mjs';
import { prepareLightPlan } from '../server/light-import.mjs';
import { createPersistence } from '../server/persistence.mjs';
import { createRequests } from '../server/business-requests.mjs';
import { createLightService } from '../server/light-service.mjs';
import { createLightMcp } from './light.mjs';

test('D 所有者 HTTP 与真实 STDIO 登记、绑定、可靠状态、撤销及重开', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'light-owner-d-'));
  const dataDir = path.join(root, 'data');
  const worktree = path.join(root, 'worktree');
  await mkdir(worktree);
  execFileSync('git', ['init', '-b', 'main', worktree], { windowsHide: true, stdio: 'pipe' });
  execFileSync('git', ['-C', worktree, '-c', 'user.name=D fixture', '-c', 'user.email=d-fixture@example.invalid',
    'commit', '--allow-empty', '-m', 'fixture'], { windowsHide: true, stdio: 'pipe' });
  const head = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  const ownerToken = randomBytes(32).toString('hex');
  const configFile = path.join(root, 'light-bridge.json');
  let server;
  let endpoint;
  let client;
  let diagnostics = '';
  let dropEvent = null;
  const transcript = [];
  const config = {
    dataDir, env: {}, lightAccessEnabled: true,
    authorize(req, pathname) {
      if (pathname === '/api/light-mcp') return;
      if (req.headers.authorization !== `Bearer ${ownerToken}` || req.headers.origin !== undefined) throw new HttpError(403, 'FORBIDDEN');
    },
    afterCommit(_req, response) {
      if (dropEvent && response?.value?.structuredContent?.result?.receipt?.eventId === dropEvent) {
        dropEvent = null;
        return 'drop';
      }
    },
  };
  async function startOwner() {
    server = await createServer(config);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    endpoint = `http://127.0.0.1:${server.address().port}`;
  }
  async function stopOwner() {
    if (!server?.listening) return;
    const closed = once(server, 'close');
    server.close(); server.closeAllConnections(); await closed;
  }
  async function startBridge(token) {
    await writeFile(configFile, JSON.stringify({ endpoint, token }), { mode: 0o600 });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('./light-stdio.mjs', import.meta.url))],
      env: { WORKBENCH_LIGHT_CONFIG: configFile }, stderr: 'pipe' });
    transport.stderr.on('data', chunk => { diagnostics += chunk; });
    client = new Client({ name: 'D-owner-stdio-test', version: '0.1.0' });
    await client.connect(transport, { timeout: 10000 });
  }
  async function privateRequest(route, body, token = ownerToken) {
    const response = await fetch(`${endpoint}${route}`, { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
    }, body: JSON.stringify(body), redirect: 'error' });
    const value = await response.json();
    transcript.push({ route, status: response.status, value });
    return { status: response.status, value };
  }
  async function privateCall(route, body) {
    const response = await privateRequest(route, body);
    assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(response.value));
    return response.value;
  }
  async function call(name, input) {
    const response = await client.callTool({ name, arguments: input });
    transcript.push({ name, input, response });
    return response.structuredContent;
  }
  function accepted(response) {
    assert.equal(response?.status, 'accepted', JSON.stringify(response));
    return response.result;
  }
  t.after(async () => {
    await client?.close();
    await stopOwner();
    await rm(root, { recursive: true, force: true });
  });
  await startOwner();
  const projectKey = 'D-owner/project';
  const planKey = 'D-owner/plan';
  const threadId = randomUUID();
  const hostId = 'local';
  const access = await privateCall('/api/light-access/grants', {
    projectKeys: [projectKey], threadId, hostId, worktreeRoots: [worktree], acknowledged: true,
  });
  assert.equal(typeof access.principal, 'string');
  assert.match(access.token, /^[a-f0-9]{64,}$/i);
  await startBridge(access.token);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 9);
  assert.equal((await privateRequest('/api/light-access/grants', {
    projectKeys: ['unauthorized'], threadId, hostId, worktreeRoots: [worktree], acknowledged: true,
  }, access.token)).status, 403, 'MCP 凭据不能签发授权');
  const sourcePath = new URL('../../docs/03_轻量路线工作台/03_测试样例/01_模拟二十步骤与六分支工作树_测试文档_2026-11-10.md', import.meta.url);
  const context = { sessionGroup: 'D', threadId, hostId, folderId: null, worktreeOrdinal: 1,
    worktreePath: worktree, branch: 'main', head, trust: 'declared' };
  const candidate = prepareLightPlan({ text: await readFile(sourcePath, 'utf8'), sourcePath: sourcePath.pathname,
    version: 'D-owner-fixed', projectKey, planKey, name: 'D 私有所有者独立项目', date: '2026-11-10', context });
  const source = Object.fromEntries(Object.entries(candidate.plans[0].source).filter(([key]) => key !== 'trust'));
  const registration = { schemaVersion: 'light-1.0', expectedRevision: 0, eventId: 'D-register', source,
    occurredAt: '2026-11-10T23:00:00+08:00', snapshot: candidate };
  const confirmedPublication = await privateCall('/api/light-access/confirm-publication', {
    principal: access.principal, operation: 'register', input: registration, acknowledged: true,
  });
  const registrationRequest = { ...registration, confirmationGrant: confirmedPublication.confirmationGrant };
  const registered = accepted(await call('workbench_register_plan', registrationRequest));
  assert.deepEqual(accepted(await call('workbench_register_plan', registrationRequest)), registered);
  const projectId = registered.projectId;
  const planId = registered.planIds[0];
  let snapshot;
  async function read() {
    snapshot = accepted(await call('workbench_get_project', { projectId }));
    return snapshot;
  }
  await read();
  const base = eventId => ({ schemaVersion: 'light-1.0', projectId, planId,
    expectedRevision: snapshot.projects[0].revision, eventId, source,
    occurredAt: '2026-11-10T23:00:00+08:00', reason: 'D HTTP 与 STDIO 集成验证' });
  const step = snapshot.steps[0];
  const proposal = { ...base('D-propose'), action: 'propose', stepIds: [step.id], context,
    bindingId: null, expectedBindingRevision: null, confirmationGrant: null };
  const proposed = accepted(await call('workbench_bind_context', proposal));
  await read();
  const confirmInput = { ...proposal, ...base('D-confirm'), action: 'confirm', bindingId: proposed.bindingId,
    expectedBindingRevision: proposed.bindingRevision, confirmationGrant: null };
  const wrongBranch = await privateRequest('/api/light-access/confirm-binding', {
    principal: access.principal, input: { ...confirmInput, context: { ...context, branch: 'other-branch' } }, acknowledged: true,
  });
  assert.ok(wrongBranch.status >= 400, '可信绑定确认须拒绝与实际 Git 分支不符的声明');
  const bindingGrant = await privateCall('/api/light-access/confirm-binding', {
    principal: access.principal, input: confirmInput, acknowledged: true,
  });
  const bindingRequest = { ...confirmInput, confirmationGrant: bindingGrant.confirmationGrant };
  const confirmed = accepted(await call('workbench_bind_context', bindingRequest));
  await read();
  const reserved = accepted(await call('workbench_reserve_execution', base('D-reserve')));
  await read();
  const start = { ...base('D-start'), stepId: step.id, executionId: reserved.executionId,
    bindingId: confirmed.bindingId, bindingRevision: confirmed.bindingRevision,
    targetStatus: 'running', evidence: [], checks: [], blocker: null, reopen: null, successorImpact: null };
  const started = accepted(await call('workbench_update_step_status', start));
  assert.deepEqual(accepted(await call('workbench_update_step_status', start)), started);
  assert.equal((await call('workbench_update_step_status', { ...start, reason: 'changed' })).error.code, 'IDEMPOTENCY_CONFLICT');
  const stale = await call('workbench_update_step_status', { ...start, eventId: 'D-stale' });
  assert.equal(stale.error.code, 'REVISION_CONFLICT');
  assert.equal(stale.error.currentRevision, started.revision);
  execFileSync('git', ['-C', worktree, '-c', 'user.name=D fixture', '-c', 'user.email=d-fixture@example.invalid',
    'commit', '--allow-empty', '-m', 'progress'], { windowsHide: true, stdio: 'pipe' });
  const progressHead = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  assert.notEqual(progressHead, head, '正常提交使 HEAD 前进，绑定保留起始 HEAD');
  await read();
  const beforeBranchChange = snapshot.projects[0].revision;
  execFileSync('git', ['-C', worktree, 'switch', '-c', 'temporary-branch'], { windowsHide: true, stdio: 'pipe' });
  try {
    const wrongBranchUpdate = await call('workbench_update_step_status', { ...start, ...base('D-wrong-branch') });
    assert.equal(wrongBranchUpdate.error.code, 'STALE_BINDING', '切换分支后拒绝基于旧责任绑定的新更新');
    await read();
    assert.equal(snapshot.projects[0].revision, beforeBranchChange, '拒绝的分支更新不得递增版本');
  } finally {
    execFileSync('git', ['-C', worktree, 'switch', 'main'], { windowsHide: true, stdio: 'pipe' });
  }
  const parallel = await Promise.all(['D-progress-a', 'D-progress-b'].map(eventId => call('workbench_update_step_status', {
    ...start, ...base(eventId), reason: eventId,
  })));
  assert.equal(parallel.filter(response => response.status === 'accepted').length, 1);
  assert.equal(parallel.filter(response => response.error?.code === 'REVISION_CONFLICT').length, 1);
  assert.equal((await call('workbench_get_project', { projectId: randomUUID() })).error.code, 'FORBIDDEN');
  const proof = [{ evidenceId: 'D-http-proof', location: 'fixture://D-http-stdio', method: '真实协议自动化断言',
    deliveryVersion: 'D-owner-fixture-v1', result: 'passed' }];
  await read();
  const finish = { ...start, ...base('D-finish'), targetStatus: 'completed', evidence: proof,
    checks: step.conditions.map(check => ({ ...check, result: 'passed', evidenceIds: [proof[0].evidenceId] })) };
  dropEvent = 'D-finish';
  const unknown = await call('workbench_update_step_status', finish);
  assert.equal(unknown.error.code, 'UNKNOWN_RESULT');
  const queried = accepted(await call('workbench_query_event', { projectId, operation: 'update', eventId: 'D-finish' }));
  assert.equal(queried.state, 'committed');
  assert.equal(queried.result.executionId, reserved.executionId);
  assert.deepEqual(accepted(await call('workbench_update_step_status', finish)), queried.result);
  await read();
  assert.equal(snapshot.steps[0].status, 'completed');
  assert.equal(snapshot.executions.length, 1);
  assert.equal(snapshot.events.filter(event => event.toStatus === 'completed').length, 1);
  const beforeRestart = snapshot;
  await client.close();
  await stopOwner();
  await startOwner();
  await startBridge(access.token);
  await read();
  assert.deepEqual(snapshot, beforeRestart);
  const restored = accepted(await call('workbench_query_event', { projectId, operation: 'update', eventId: 'D-finish' }));
  assert.deepEqual(restored, queried);
  const revoke = { ...bindingRequest, ...base('D-revoke-binding'), action: 'revoke', expectedBindingRevision: confirmed.bindingRevision };
  accepted(await call('workbench_bind_context', revoke));
  await read();
  assert.equal((await call('workbench_update_step_status', { ...finish, ...base('D-late') })).error.code, 'STALE_BINDING');
  await privateCall('/api/light-access/revoke', { principal: access.principal, acknowledged: true });
  assert.equal((await call('workbench_get_project', { projectId })).error.code, 'FORBIDDEN');
  assert.equal(diagnostics.includes(access.token), false);
  assert.equal(diagnostics.includes(ownerToken), false);
  if (process.env.D_EVIDENCE_DIR) {
    const secrets = [access.token, ownerToken, confirmedPublication.confirmationGrant, bindingGrant.confirmationGrant];
    let serialized = JSON.stringify({ date: '2026-11-11', environment: '独立临时 Git 与数据目录，真实 STDIO 子进程、HTTP 所有者服务重开',
      tools, transcript, beforeRestart, git: { initialHead: head, progressHead, returnedBranch: 'main' }, diagnostics }, null, 2);
    for (const secret of secrets) serialized = serialized.replaceAll(secret, '[REDACTED]');
    await mkdir(process.env.D_EVIDENCE_DIR, { recursive: true });
    await writeFile(path.join(process.env.D_EVIDENCE_DIR, 'owner-stdio-http.json'), serialized, 'utf8');
  }
});

test('D 持久提交标志后故障保持未知，重开按原事件查询并回放一次结果', async t => {
  const results = [];
  for (const phase of ['committed', 'installed']) {
    await t.test(phase, async t => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'light-d-unknown-'));
      const connections = [];
      t.after(async () => {
        for (const connection of connections) { await connection.client.close(); await connection.server.close(); }
        await rm(root, { recursive: true, force: true });
      });
      let armed = false;
      let persistence = await createPersistence(root, { fault: async point => {
        if (armed && point === phase) { armed = false; throw new Error('secret-storage-path'); }
      } });
      let service = createLightService(persistence, createRequests(persistence), { authorize: () => true });
      const sourcePath = new URL('../../docs/03_轻量路线工作台/03_测试样例/01_模拟二十步骤与六分支工作树_测试文档_2026-11-10.md', import.meta.url);
      const context = { sessionGroup: 'D', threadId: null, hostId: null, folderId: null, worktreeOrdinal: 1,
        worktreePath: 'G:\\storage-fixture', branch: 'fixture', head: null, trust: 'declared' };
      const candidate = prepareLightPlan({ text: await readFile(sourcePath, 'utf8'), sourcePath: sourcePath.pathname,
        version: 'D-storage-fixed', projectKey: 'D-storage/project', planKey: 'D-storage/plan', name: 'D 存储未知结果独立副本', date: '2026-11-11', context });
      const registered = await service.register('storage-owner', { eventId: 'register', expectedRevision: 0, snapshot: candidate });
      const projectId = registered.projectId, planId = registered.planIds[0];
      let snapshot = service.read('storage-owner', projectId);
      const source = Object.fromEntries(Object.entries(snapshot.plans[0].source).filter(([key]) => key !== 'trust'));
      const base = eventId => ({ schemaVersion: 'light-1.0', projectId, planId, eventId,
        expectedRevision: snapshot.projects[0].revision, source, occurredAt: '2026-11-11T00:00:00+08:00', reason: '持久标志后故障恢复验证' });
      const binding = { key: 'D-storage/binding', id: randomUUID(), projectKey: candidate.projects[0].key, planKey: candidate.plans[0].key,
        stepKeys: snapshot.steps.map(step => step.key), bindingRevision: 1, state: 'confirmed', context,
        confirmationRef: 'storage-test-only-confirmation', revokedAt: null };
      await service.acceptBinding('storage-owner', { ...base('bind'), binding });
      snapshot = service.read('storage-owner', projectId);
      const reserved = await service.reserveExecutionId('storage-owner', base('reserve'));
      snapshot = service.read('storage-owner', projectId);
      const start = { ...base('start-fault'), stepId: snapshot.steps[0].id, executionId: reserved.executionId,
        bindingId: binding.id, bindingRevision: 1, targetStatus: 'running', evidence: [], checks: [], blocker: null,
        reopen: null, successorImpact: null };
      async function connect(currentService) {
        const server = createLightMcp({ service: currentService, authenticate: () => 'storage-owner' });
        const [a, b] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'D-storage-fault-test', version: '0.1.0' });
        connections.push({ client, server });
        await server.connect(b); await client.connect(a);
        return client;
      }
      const first = await connect(service);
      armed = true;
      const unknown = await first.callTool({ name: 'workbench_update_step_status', arguments: start });
      assert.equal(unknown.structuredContent.status, 'unknown');
      assert.equal(unknown.structuredContent.error.code, 'INTERNAL_ERROR');
      assert.equal(unknown.structuredContent.error.recovery, 'queryOriginalEventBeforeRetry');
      assert.equal(JSON.stringify(unknown).includes('secret-storage-path'), false);
      const unavailable = await first.callTool({ name: 'workbench_get_project', arguments: { projectId } });
      assert.equal(unavailable.structuredContent.error.code, 'RECOVERY_REQUIRED');
      persistence = await createPersistence(root);
      service = createLightService(persistence, createRequests(persistence), { authorize: () => true });
      const reopened = await connect(service);
      const queried = await reopened.callTool({ name: 'workbench_query_event', arguments: { projectId, operation: 'update', eventId: 'start-fault' } });
      assert.equal(queried.structuredContent.result.state, 'committed');
      const replay = await reopened.callTool({ name: 'workbench_update_step_status', arguments: start });
      assert.deepEqual(replay.structuredContent.result, queried.structuredContent.result.result);
      const after = service.read('storage-owner', projectId);
      assert.equal(after.steps[0].status, 'running');
      assert.equal(after.executions.length, 1);
      assert.equal(after.events.filter(event => event.toStatus === 'running').length, 1);
      assert.equal(persistence.read('audit').filter(event => event.operation === 'light.update').length, 1);
      assert.equal(after.projects[0].revision, start.expectedRevision + 1);
      results.push({ phase, unknown: unknown.structuredContent, queried: queried.structuredContent,
        replay: replay.structuredContent, snapshot: after });
    });
  }
  if (process.env.D_EVIDENCE_DIR) {
    await mkdir(process.env.D_EVIDENCE_DIR, { recursive: true });
    await writeFile(path.join(process.env.D_EVIDENCE_DIR, 'storage-unknown-result.json'), JSON.stringify({
      date: '2026-11-11', environment: '独立持久目录、SDK InMemoryTransport、提交阶段故障注入及重开', results,
    }, null, 2), 'utf8');
  }
});
