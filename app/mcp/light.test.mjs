// 日期 2026-11-10。SDK 协议测试采用独立持久目录及可信测试确认适配器。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLightMcp, lightTools } from './light.mjs';
import { createPersistence } from '../server/persistence.mjs';
import { createRequests } from '../server/business-requests.mjs';
import { createLightService } from '../server/light-service.mjs';
import { prepareLightPlan } from '../server/light-import.mjs';
import { createLightPublication } from '../server/light-publication.mjs';

test('D SDK 发现、登记、开始、阻塞恢复、结束、回放冲突、授权与重启查询', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'light-d-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = new URL('../../docs/03_轻量路线工作台/03_测试样例/01_模拟二十步骤与六分支工作树_测试文档_2026-11-10.md', import.meta.url);
  const context = { sessionGroup: 'D', threadId: null, hostId: null, folderId: null, worktreeOrdinal: 1,
    worktreePath: 'G:\\fixture', branch: 'fixture', head: null, trust: 'declared' };
  const candidate = prepareLightPlan({ text: await readFile(sourcePath, 'utf8'), sourcePath: sourcePath.pathname,
    version: 'D-fixed', projectKey: 'D-fixture/project', planKey: 'D-fixture/plan', name: 'D SDK 测试副本', date: '2026-11-10', context });
  let authorized = true;
  let persistence = await createPersistence(root);
  const authorize = principal => authorized && principal === 'test-owner';
  let service = createLightService(persistence, createRequests(persistence), { authorize, confirmBinding: (_principal, _binding, input) => input.confirmationGrant === 'test-only-binding-confirmed' });
  const publisher = createLightPublication(persistence, createRequests(persistence), service, { authorize });
  const server = createLightMcp({ service, authenticate: () => authorized ? 'test-owner' : null,
    publish: publisher.publish, bind: (principal, _operation, input) => service.bind(principal, input) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'D-SDK-fixture', version: '0.1.0' });
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const transcript = [];
  async function call(name, input) {
    const response = await client.callTool({ name, arguments: input });
    transcript.push({ name, input, response }); return response.structuredContent;
  }
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 11);
  assert.deepEqual(listed.tools.map(tool => tool.name), lightTools.map(tool => tool.name));
  const source = Object.fromEntries(Object.entries(candidate.plans[0].source).filter(([key]) => key !== 'trust'));
  const registration = { schemaVersion: 'light-1.0', expectedRevision: 0,
    eventId: 'register', source, occurredAt: '2026-11-10T23:00:00+08:00', snapshot: candidate };
  assert.equal((await call('workbench_register_plan', { ...registration, confirmationGrant: 'invalid' })).error.code, 'CONFIRMATION_REQUIRED');
  assert.equal((await call('workbench_register_plan', { ...registration, confirmationGrant: null })).error.code, 'CONFIRMATION_REQUIRED', '旧版限范围模式不能使用自动连接的空票据');
  const confirmation = await publisher.confirm('test-owner', 'register', registration);
  const registered = await call('workbench_register_plan', { ...registration, confirmationGrant: confirmation.confirmationGrant });
  assert.deepEqual(await call('workbench_register_plan', { ...registration, confirmationGrant: confirmation.confirmationGrant }), registered);
  const forged = structuredClone(registration);
  forged.snapshot.plans[0].source.trust = 'hostObserved';
  await assert.rejects(client.callTool({ name: 'workbench_register_plan', arguments: { ...forged, confirmationGrant: confirmation.confirmationGrant } }), /Invalid/);
  const projectId = registered.result.projectId, planId = registered.result.planIds[0];
  assert.deepEqual((await call('workbench_query_event', { projectId, operation: 'register', eventId: 'register' })).result.result,
    registered.result, '登记成功后可用真实服务身份回查原请求');
  let snapshot = (await call('workbench_get_project', { projectId })).result;
  const base = (eventId, revision = snapshot.projects[0].revision) => ({ schemaVersion: 'light-1.0', projectId, planId,
    expectedRevision: revision, eventId, source, occurredAt: '2026-11-10T23:00:00+08:00', reason: 'D SDK 隔离验证' });
  const proposal = { ...base('binding-propose'), action: 'propose', stepIds: snapshot.steps.map(step => step.id), context,
    bindingId: null, expectedBindingRevision: null, confirmationGrant: null };
  const proposed = await call('workbench_bind_context', proposal);
  snapshot = (await call('workbench_get_project', { projectId })).result;
  const confirmationInput = { ...proposal, ...base('binding-confirm'), action: 'confirm', bindingId: proposed.result.bindingId,
    expectedBindingRevision: 1, confirmationGrant: 'test-only-binding-confirmed' };
  assert.equal((await call('workbench_bind_context', { ...confirmationInput, confirmationGrant: 'invalid' })).error.code, 'CONFIRMATION_REQUIRED');
  const confirmed = await call('workbench_bind_context', confirmationInput);
  const bound = { id: confirmed.result.bindingId, revision: confirmed.result.bindingRevision };
  snapshot = (await call('workbench_get_project', { projectId })).result;
  const reserved = await call('workbench_reserve_execution', base('reserve'));
  snapshot = (await call('workbench_get_project', { projectId })).result;
  const step = snapshot.steps[0];
  const start = { ...base('start'), stepId: step.id, executionId: reserved.result.executionId, bindingId: bound.id,
    bindingRevision: bound.revision, targetStatus: 'running', evidence: [], checks: [], blocker: null, reopen: null, successorImpact: null };
  const started = await call('workbench_update_step_status', start);
  assert.equal(started.status, 'accepted');
  assert.deepEqual(await call('workbench_update_step_status', start), started);
  assert.equal((await call('workbench_update_step_status', { ...start, reason: 'changed' })).error.code, 'IDEMPOTENCY_CONFLICT');
  const conflict = await call('workbench_update_step_status', { ...start, eventId: 'stale' });
  assert.equal(conflict.error.code, 'REVISION_CONFLICT'); assert.equal(conflict.error.currentRevision, started.result.revision);
  const blocker = { blockerId: 'D-blocker', reason: '外部测试等待', waitingFor: ['fixture'], releaseConditions: ['fixture ready'], resolved: false };
  const blocked = await call('workbench_update_step_status', { ...start, eventId: 'block', expectedRevision: started.result.revision, targetStatus: 'blocked', blocker });
  const resumed = await call('workbench_update_step_status', { ...start, eventId: 'resume', expectedRevision: blocked.result.revision, blocker: { ...blocker, resolved: true } });
  const evidence = [{ evidenceId: 'D-proof', location: 'fixture://D', method: 'SDK assertion', deliveryVersion: 'D-fixture-v1', result: 'passed' }];
  const finish = { ...start, eventId: 'finish', expectedRevision: resumed.result.revision, targetStatus: 'completed', evidence,
    checks: step.conditions.map(check => ({ ...check, result: 'passed', evidenceIds: ['D-proof'] })) };
  const finished = await call('workbench_update_step_status', finish);
  assert.equal(finished.status, 'accepted');
  assert.deepEqual(await call('workbench_update_step_status', start), started, '旧版本已提交事件回放');
  const query = await call('workbench_query_event', { projectId, operation: 'update', eventId: 'finish' });
  assert.deepEqual(query.result.result, finished.result, '响应丢失后使用原键取得同一结果');
  assert.equal((await call('workbench_get_project', { projectId: randomUUID() })).error.code, 'NOT_FOUND');
  await assert.rejects(client.callTool({ name: 'workbench_get_project', arguments: { projectId, principal: 'admin' } }), /Invalid/);
  authorized = false;
  assert.equal((await call('workbench_update_step_status', finish)).error.code, 'FORBIDDEN');
  authorized = true;
  snapshot = (await call('workbench_get_project', { projectId })).result;
  const revoked = await call('workbench_bind_context', { ...confirmationInput, ...base('revoke'), action: 'revoke', expectedBindingRevision: bound.revision });
  assert.equal(revoked.status, 'accepted');
  assert.equal((await call('workbench_update_step_status', { ...finish, eventId: 'late', expectedRevision: revoked.result.revision })).error.code, 'STALE_BINDING');
  assert.deepEqual(await call('workbench_update_step_status', start), started, '撤销绑定后仍可按有效读取授权回放已提交结果');
  persistence = await createPersistence(root);
  service = createLightService(persistence, createRequests(persistence), { authorize: () => true });
  const after = service.read('test-owner', projectId);
  assert.equal(after.steps[0].status, 'completed'); assert.equal(after.executions.length, 1);
  assert.equal(after.executions[0].outcome, 'completedScope');
  assert.equal(after.events.filter(event => event.toStatus === 'completed').length, 1);
  assert.deepEqual(service.query('test-owner', projectId, 'update', 'finish').result, finished.result);
  if (process.env.D_EVIDENCE_DIR) {
    await mkdir(process.env.D_EVIDENCE_DIR, { recursive: true });
    await writeFile(path.join(process.env.D_EVIDENCE_DIR, 'sdk-protocol.json'), JSON.stringify({ date: '2026-11-10',
      environment: 'SDK InMemoryTransport，独立持久目录，测试确认与绑定，宿主业务写入尚未接入', listed, transcript, after }, null, 2), 'utf8');
  }
});

test('D 默认拒绝认证，未知内部异常脱敏', async t => {
  const server = createLightMcp({ service: {}, authenticate: () => { throw new Error('secret/token/path'); } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'D-errors', version: '0.1.0' });
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const response = await client.callTool({ name: 'workbench_get_project', arguments: { projectId: 'test' } });
  assert.equal(response.structuredContent.error.code, 'INTERNAL_ERROR');
  assert.equal(JSON.stringify(response).includes('secret'), false);
});
