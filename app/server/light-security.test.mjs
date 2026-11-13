// 日期 2026-11-10。D 接入的会话绑定、执行身份和细分授权回归。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPersistence } from './persistence.mjs';
import { createRequests } from './business-requests.mjs';
import { createLightService } from './light-service.mjs';
import { prepareLightPlan } from './light-import.mjs';
import { createLightPublication } from './light-publication.mjs';
import { digest } from './receipts.mjs';

const context = { sessionGroup: 'D', threadId: 'owner-thread', hostId: 'local', folderId: null,
  worktreeOrdinal: 1, worktreePath: 'G:\\fixture', branch: 'fixture', head: null, trust: 'declared' };
const sourcePath = new URL('../../docs/03_轻量路线工作台/03_测试样例/01_模拟二十步骤与六分支工作树_测试文档_2026-11-10.md', import.meta.url);
const original = await readFile(sourcePath, 'utf8');

test('starting an existing plan focuses its route once and progress updates preserve a later manual choice', async t => {
  const f = await fixture(t);
  const reserved = await f.service.reserveExecutionId('owner', f.base('reserve-focus'));
  const request = f.update('start-focus', reserved.executionId);
  await f.service.update('owner', request);
  const route = f.snapshot().routes.find(route => route.stepKeys.includes(f.step.key));
  assert.equal(f.persistence.read('lightPanelPreferences').selected, f.step.key);
  assert.deepEqual(f.persistence.read('lightPanelPreferences').focus, [route.key]);
  const manual = { collapsed: [], selected: 'manual-selection', focus: ['manual-route'], scroll: {}, y: {} };
  await f.persistence.run(() => f.persistence.write('lightPanelPreferences', manual));
  await f.service.update('owner', f.update('progress-focus', reserved.executionId));
  assert.deepEqual(f.persistence.read('lightPanelPreferences'), manual);
  await f.service.update('owner', request);
  assert.deepEqual(f.persistence.read('lightPanelPreferences'), manual);
});

test('new registration leads the list and selects its first route without changing existing task states or resetting selection on replay', async t => {
  const f = await fixture(t);
  const previousSteps = f.persistence.read('light').snapshot.steps;
  const candidate = prepareLightPlan({ text: original, sourcePath: sourcePath.pathname, version: 'new-focus',
    projectKey: 'new-focus/project', planKey: 'new-focus/plan', name: 'New focus', date: '2026-11-13', context });
  const request = { eventId: 'new-focus', expectedRevision: 0, snapshot: candidate };
  const result = await f.service.register('owner', request);
  const saved = f.persistence.read('light').snapshot;
  assert.equal(saved.projects[0].id, result.projectId);
  assert.equal(saved.plans[0].key, candidate.plans[0].key);
  assert.equal(saved.routes[0].key, candidate.routes[0].key);
  assert.equal(saved.uiPreferences.selectedStepKey, candidate.routes[0].stepKeys[0]);
  assert.equal(f.persistence.read('lightPanelPreferences').selected, candidate.routes[0].stepKeys[0]);
  assert.deepEqual(saved.steps.filter(step => previousSteps.some(old => old.key === step.key)), previousSteps);
  await f.persistence.run(() => f.persistence.write('lightPanelPreferences', { collapsed: [], selected: previousSteps[0].key, focus: [], scroll: {}, y: {} }));
  assert.deepEqual(await f.service.register('owner', request), result);
  assert.equal(f.persistence.read('lightPanelPreferences').selected, previousSteps[0].key);
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'light-security-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const persistence = await createPersistence(root);
  let canRevoke = false;
  let contextValid = true;
  let contextChecks = 0;
  const seen = [];
  function authorize(principal, projectId, operation, details = {}) {
    seen.push({ principal, projectId, operation, details: structuredClone(details) });
    if (!['owner', 'other'].includes(principal)) return false;
    if (operation === 'revokeBinding') return canRevoke && principal === 'owner';
    if (operation === 'update' && details.binding) {
      return principal === 'owner' && details.binding.context.threadId === context.threadId
        && details.binding.context.hostId === context.hostId && details.step.id === details.input.stepId;
    }
    return true;
  }
  const service = createLightService(persistence, createRequests(persistence), { authorize,
    confirmBinding: () => true,
    verifyExecutionContext: async () => { contextChecks += 1; return contextValid; } });
  const candidate = prepareLightPlan({ text: original, sourcePath: sourcePath.pathname, version: 'D-security',
    projectKey: 'D-security/project', planKey: 'D-security/plan', name: 'D 安全回归副本', date: '2026-11-10', context });
  const result = await service.register('owner', { eventId: 'register', expectedRevision: 0, snapshot: candidate });
  const projectId = result.projectId, planId = result.planIds[0];
  const snapshot = () => service.read('owner', projectId);
  const source = Object.fromEntries(Object.entries(candidate.plans[0].source).filter(([key]) => key !== 'trust'));
  const base = eventId => ({ schemaVersion: 'light-1.0', projectId, planId, eventId,
    expectedRevision: snapshot().projects[0].revision, source, occurredAt: '2026-11-10T23:00:00+08:00', reason: 'D 权限回归' });
  const step = snapshot().steps[0];
  const proposal = { ...base('propose'), action: 'propose', stepIds: [step.id], context,
    bindingId: null, expectedBindingRevision: null, confirmationGrant: null };
  const proposed = await service.bind('owner', proposal);
  const confirmed = await service.bind('owner', { ...proposal, ...base('confirm'), action: 'confirm',
    bindingId: proposed.bindingId, expectedBindingRevision: 1, confirmationGrant: 'trusted-test-confirmation' });
  function update(eventId, executionId, extra = {}) {
    return { ...base(eventId), stepId: step.id, executionId, bindingId: confirmed.bindingId,
      bindingRevision: confirmed.bindingRevision, targetStatus: 'running', evidence: [], checks: [],
      blocker: null, reopen: null, successorImpact: null, ...extra };
  }
  return { persistence, service, snapshot, base, step, proposal, confirmed, update, seen,
    allowRevoke: () => { canRevoke = true; },
    setContextValid: value => { contextValid = value; }, getContextChecks: () => contextChecks };
}

test('D 不同认证会话不能使用已确认责任绑定，拒绝后版本不变', async t => {
  const f = await fixture(t);
  const execution = await f.service.reserveExecutionId('other', f.base('reserve-other'));
  const before = f.snapshot();
  await assert.rejects(f.service.update('other', f.update('impersonate', execution.executionId)), /FORBIDDEN/);
  assert.deepEqual(f.snapshot(), before);
  assert.ok(f.seen.some(call => call.principal === 'other' && call.operation === 'update'
    && call.details.binding?.id === f.confirmed.bindingId && call.details.step?.id === f.step.id));
});

test('D 绑定提议和确认分别授权，提议权限不能撤销责任绑定', async t => {
  const f = await fixture(t);
  assert.ok(f.seen.some(call => call.operation === 'proposeBinding' && call.details.steps[0].id === f.step.id));
  assert.ok(f.seen.some(call => call.operation === 'confirmBinding' && call.details.binding.id === f.confirmed.bindingId));
  const revoke = { ...f.proposal, ...f.base('revoke'), action: 'revoke', bindingId: f.confirmed.bindingId,
    expectedBindingRevision: f.confirmed.bindingRevision };
  const before = f.snapshot();
  await assert.rejects(f.service.bind('owner', revoke), /FORBIDDEN/);
  assert.deepEqual(f.snapshot(), before);
  f.allowRevoke();
  assert.equal((await f.service.bind('owner', revoke)).state, 'revoked');
});

test('D 执行预留身份绑定主体，旧无作用域预留不能创建新执行', async t => {
  const f = await fixture(t);
  const other = await f.service.reserveExecutionId('other', f.base('reserve-other'));
  await assert.rejects(f.service.update('owner', f.update('borrow-reservation', other.executionId)), /STALE_EXECUTION/);
  const legacyId = randomUUID();
  await f.persistence.run(() => {
    const value = f.persistence.read('light');
    value.metadata.reservedExecutions.push(legacyId);
    f.persistence.write('light', value);
  });
  await assert.rejects(f.service.update('owner', f.update('legacy-reservation', legacyId)), /STALE_EXECUTION/);
  const own = await f.service.reserveExecutionId('owner', f.base('reserve-owner'));
  for (const field of ['projectId', 'planId']) {
    await f.persistence.run(() => {
      const value = f.persistence.read('light');
      const reservation = value.metadata.reservedExecutions.find(item => item.executionId === own.executionId);
      reservation[field] = randomUUID();
      f.persistence.write('light', value);
    });
    await assert.rejects(f.service.update('owner', f.update(`wrong-${field}`, own.executionId)), /STALE_EXECUTION/);
    await f.persistence.run(() => {
      const value = f.persistence.read('light');
      value.metadata.reservedExecutions.find(item => item.executionId === own.executionId)[field] = f.base('basis')[field];
      f.persistence.write('light', value);
    });
  }
  assert.equal((await f.service.update('owner', f.update('start-owner', own.executionId))).executionId, own.executionId);
});

test('D 绑定撤销后已提交事件仍先回放，新事件拒绝，旧执行历史继续可读', async t => {
  const f = await fixture(t);
  const reserved = await f.service.reserveExecutionId('owner', f.base('reserve'));
  const start = f.update('start', reserved.executionId);
  const started = await f.service.update('owner', start);
  f.allowRevoke();
  await f.service.bind('owner', { ...f.proposal, ...f.base('revoke'), action: 'revoke',
    bindingId: f.confirmed.bindingId, expectedBindingRevision: f.confirmed.bindingRevision });
  assert.deepEqual(await f.service.update('owner', start), started);
  await assert.rejects(f.service.update('owner', f.update('late', reserved.executionId)), /STALE_BINDING/);
  await f.persistence.run(() => {
    const value = f.persistence.read('light');
    value.metadata.reservedExecutions = [reserved.executionId];
    f.persistence.write('light', value);
  });
  assert.equal(f.snapshot().executions[0].id, reserved.executionId);
  assert.deepEqual(await f.service.update('owner', start), started);
});

test('D 发布查询返回完整工具请求语义，旧直接领域登记查询仍可用', async t => {
  const f = await fixture(t);
  assert.equal(f.service.query('owner', f.base('basis').projectId, 'register', 'register').state, 'committed');
  const candidate = prepareLightPlan({ text: original, sourcePath: sourcePath.pathname, version: 'D-publication-query',
    projectKey: 'D-publication/project', planKey: 'D-publication/plan', name: 'D 发布查询副本', date: '2026-11-10', context });
  const input = { schemaVersion: 'light-1.0', expectedRevision: 0, eventId: 'confirmed-register', snapshot: candidate,
    source: Object.fromEntries(Object.entries(candidate.plans[0].source).filter(([key]) => key !== 'trust')),
    occurredAt: '2026-11-10T23:00:00+08:00' };
  const publisher = createLightPublication(f.persistence, createRequests(f.persistence), f.service, { authorize: () => true });
  const grant = await publisher.confirm('owner', 'register', input);
  const publishedInput = { ...input, confirmationGrant: grant.confirmationGrant };
  const result = await publisher.publish('owner', 'register', publishedInput);
  const query = f.service.query('owner', result.projectId, 'register', input.eventId);
  assert.equal(query.semanticHash, digest({ ...publishedInput, idempotencyKey: input.eventId }));
  assert.deepEqual(query.result, result);
  assert.equal(f.service.query('owner', f.base('basis').projectId, 'register', 'register').state, 'committed');
});

test('D 新更新核验真实执行上下文，已提交回放优先于再次核验', async t => {
  const f = await fixture(t);
  const reserved = await f.service.reserveExecutionId('owner', f.base('reserve-context'));
  const start = f.update('start-context', reserved.executionId);
  f.setContextValid(false);
  const before = f.snapshot();
  await assert.rejects(f.service.update('owner', start), /STALE_BINDING/);
  assert.deepEqual(f.snapshot(), before);
  f.setContextValid(true);
  const started = await f.service.update('owner', start);
  const checks = f.getContextChecks();
  f.setContextValid(false);
  assert.deepEqual(await f.service.update('owner', start), started);
  assert.equal(f.getContextChecks(), checks);
  await assert.rejects(f.service.update('owner', f.update('new-progress-context', reserved.executionId)), /STALE_BINDING/);
});
