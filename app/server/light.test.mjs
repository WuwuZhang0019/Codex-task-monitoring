// 日期 2026-11-10。B 阶段通过持久领域入口验证，所有目录均为独立副本。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, cp, rmdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createPersistence } from './persistence.mjs';
import { createRequests } from './business-requests.mjs';
import { createLightService } from './light-service.mjs';
import { createLightOutbox } from './light-outbox.mjs';
import { prepareLightPlan, legacyLightStatus } from './light-import.mjs';
import { validateLightSnapshot, transitions } from './light-model.mjs';
import { digest } from './receipts.mjs';
import { createServer } from './index.mjs';
import { project as oldProject, model as oldModel } from '../tests/helpers/output-fixture.mjs';

const sourcePath = new URL('../../docs/03_轻量路线工作台/03_测试样例/01_模拟二十步骤与六分支工作树_测试文档_2026-11-10.md', import.meta.url);
const original = await readFile(sourcePath, 'utf8');
const context = { sessionGroup: 'A', threadId: null, hostId: null, folderId: null, worktreeOrdinal: 1,
  worktreePath: 'G:\\fixture', branch: 'fixture', head: null, trust: 'declared' };
const date = '2026-11-10';
function candidate(key = 'b-fixture') {
  return prepareLightPlan({ text: original, sourcePath: sourcePath.pathname, version: 'fixed-20261110', projectKey: `${key}/project`, planKey: `${key}/plan`, name: 'B 独立二十步骤六路线', date, context });
}
function binding(snapshot, keys = snapshot.steps.filter(item => item.planKey === snapshot.plans[0].key).map(item => item.key)) {
  return { key: `${snapshot.plans[0].key}/bindings/fixture`, id: randomUUID(), projectKey: snapshot.projects[0].key, planKey: snapshot.plans[0].key,
    stepKeys: keys, bindingRevision: 1, state: 'confirmed', context, confirmationRef: 'isolated-confirmed-adapter', revokedAt: null };
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'light-b-'));
  const transcript = [];
  let persistence, service, outbox, projectId, planId;
  const authorize = options.authorize ?? (() => true);
  async function restart() {
    persistence = await createPersistence(root, { fault: options.fault });
    service = createLightService(persistence, createRequests(persistence), { authorize }); outbox = createLightOutbox(persistence);
  }
  await restart();
  t.after(() => rm(root, { recursive: true, force: true }));
  async function call(method, input) {
    try { const result = await service[method]('fixture-owner', input); transcript.push({ method, input, result }); return result; }
    catch (error) { transcript.push({ method, input, error: { code: error.code, message: error.message } }); throw error; }
  }
  const registered = await call('register', { eventId: 'register', expectedRevision: 0, snapshot: options.candidate ?? candidate() });
  projectId = registered.projectId; planId = registered.planIds[0];
  const snapshot = () => service.read('fixture-owner', projectId);
  function base(eventId = randomUUID()) { return { schemaVersion: 'light-1.0', projectId, planId, eventId, expectedRevision: snapshot().projects[0].revision,
    source: { ...Object.fromEntries(Object.entries(snapshot().plans[0].source).filter(([key]) => key !== 'trust')), locator: '二十步骤独立副本' }, occurredAt: '2026-11-10T22:00:00+08:00', reason: '隔离领域入口验证' }; }
  const bound = binding(snapshot());
  await call('acceptBinding', { ...base('binding'), binding: bound });
  function step(code) { return snapshot().steps.find(item => item.code === code); }
  async function update(code, targetStatus, extra = {}) {
    const current = step(code);
    let executionId = snapshot().executions.find(item => item.key === current.executionKey)?.id;
    if (!executionId) executionId = (await call('reserveExecutionId', base())).executionId;
    return call('update', { ...base(), stepId: current.id, executionId, bindingId: bound.id, bindingRevision: 1,
      targetStatus, evidence: [], checks: [], blocker: null, reopen: null, successorImpact: null, ...extra });
  }
  async function finish(code, deliveryVersion = 'fixture-v1') {
    const current = step(code), evidence = [{ evidenceId: `${code}/proof`, location: `fixture://${code}`, method: '持久领域入口断言', deliveryVersion, result: 'passed' }];
    return update(code, 'completed', { evidence, checks: current.conditions.map(item => ({ ...item, result: 'passed', evidenceIds: [evidence[0].evidenceId] })) });
  }
  async function evidence(name, extra = {}) {
    if (!process.env.B_EVIDENCE_DIR) return;
    await mkdir(process.env.B_EVIDENCE_DIR, { recursive: true });
    await writeFile(path.join(process.env.B_EVIDENCE_DIR, 'fixed-input.md'), original, 'utf8');
    await writeFile(path.join(process.env.B_EVIDENCE_DIR, name + '.json'), JSON.stringify({ date, sourceHash: candidate().plans[0].source.sha256, nodeVersion: process.version,
      environment: '独立数据目录，可信测试适配器，未连接宿主业务 MCP', root, transcript, snapshot: snapshot(), ...extra }, null, 2), 'utf8');
  }
  return { root, restart, call, snapshot, base, step, update, finish, evidence, bound, registered, transcript, projectId, planId,
    get persistence() { return persistence; }, get service() { return service; }, get outbox() { return outbox; } };
}

test('B-01/02 固定原文独立副本、稳定映射、缺失重复循环和路线覆盖校验', async () => {
  const snapshot = candidate();
  assert.equal(snapshot.steps.length, 20); assert.equal(snapshot.routes.length, 6);
  assert.equal(snapshot.steps[6].dependsOn.length, 2); assert.equal(snapshot.steps[16].dependsOn.length, 2);
  assert.deepEqual(candidate(), snapshot);
  assert.equal(await readFile(sourcePath, 'utf8'), original);
  for (const mutate of [
    s => s.steps[1].key = s.steps[0].key,
    s => s.steps[1].code = s.steps[0].code,
    s => s.steps[1].order = s.steps[0].order,
    s => s.steps[1].dependsOn = ['missing'],
    s => s.steps[0].dependsOn = [s.steps[1].key],
    s => s.routes[0].stepKeys.pop(),
    s => s.steps[0].parentKey = s.steps[1].key,
  ]) { const broken = structuredClone(snapshot); mutate(broken); assert.throws(() => validateLightSnapshot(broken)); }
});

test('B-06 二十步骤六路线通过真实领域入口提交、回读、重启和整体完成', async t => {
  const input = candidate();
  input.plans[0].endConditions = [{ conditionId: 'plan-exit', text: '全部步骤与最终汇总证据通过', required: true, result: 'pending', evidenceIds: [] }];
  const f = await fixture(t, { candidate: input });
  const pending = () => f.service.progress('fixture-owner', f.projectId, f.planId).routes.flatMap(route => route.runnable);
  assert.deepEqual(pending(), [f.step('A-01').key, f.step('A-04').key]);
  await assert.rejects(f.update('A-07', 'running'), /DEPENDENCY_NOT_READY/);
  for (const code of ['A-01', 'A-04']) await f.update(code, 'running');
  for (const code of ['A-01', 'A-04']) await f.finish(code);
  for (const code of ['A-02', 'A-03']) { await f.update(code, 'running'); await f.finish(code); }
  await assert.rejects(f.update('A-07', 'running'), /DEPENDENCY_NOT_READY/);
  for (const code of ['A-05', 'A-06']) { await f.update(code, 'running'); await f.finish(code); }
  for (const code of ['A-07', 'A-08', 'A-09', 'A-10']) { await f.update(code, 'running'); await f.finish(code); }
  assert.ok(pending().includes(f.step('A-11').key)); assert.ok(pending().includes(f.step('A-14').key));
  for (const code of ['A-11', 'A-12', 'A-13']) { await f.update(code, 'running'); await f.finish(code); }
  await assert.rejects(f.update('A-17', 'running'), /DEPENDENCY_NOT_READY/);
  for (const code of ['A-14', 'A-15', 'A-16', 'A-17', 'A-18', 'A-19', 'A-20']) { await f.update(code, 'running'); await f.finish(code); }
  assert.equal(f.service.progress('fixture-owner', f.projectId, f.planId).passed, false);
  await f.call('completePlan', { ...f.base('plan-completion'), checks: f.snapshot().plans[0].endConditions.map(item => ({ ...item, result: 'passed', evidenceIds: ['A-20/proof'] })), evidence: f.step('A-20').evidence });
  const before = f.snapshot();
  assert.equal(f.service.progress('fixture-owner', f.projectId, f.planId).passed, true);
  assert.equal(before.events.filter(item => item.toStatus === 'running').length, 20);
  assert.equal(before.events.filter(item => item.toStatus === 'completed').length, 20);
  await f.restart(); assert.deepEqual(f.snapshot(), before);
  await f.evidence('B20-six-routes', { progress: f.service.progress('fixture-owner', f.projectId, f.planId) });
});

test('B-03 全部 25 对状态实际转换、同状态进展及非法转换', async t => {
  const f = await fixture(t);
  const blocker = { blockerId: 'manual', reason: '外部等待', waitingFor: ['fixture'], releaseConditions: ['fixture-ready'], resolved: false };
  const statuses = ['pending', 'running', 'blocked', 'completed', 'cancelled'];
  const results = [];
  for (const from of statuses) for (const target of statuses) {
    const initial = f.persistence.read('light');
    // 用实际入口构建每个源状态，矩阵副本之间回滚至相同隔离基线。
    if (from !== 'pending') {
      if (from === 'cancelled') await f.update('A-01', 'cancelled', { successorImpact: '后继等待明确替代' });
      else { await f.update('A-01', 'running'); if (from === 'blocked') await f.update('A-01', 'blocked', { blocker }); if (from === 'completed') await f.finish('A-01'); }
    }
    const proof = { evidenceId: 'matrix', location: 'fixture://matrix', method: '25 对入口检查', deliveryVersion: 'matrix-v1', result: 'passed' };
    const extra = { successorImpact: '后继等待复核', blocker: target === 'blocked' ? blocker : from === 'blocked' ? { ...blocker, resolved: true } : null,
      reopen: ['completed', 'cancelled'].includes(from) && ['pending', 'running'].includes(target) ? { reason: '显式返工', successorImpact: '后继待复核' } : null,
      evidence: target === 'completed' ? [proof] : [], checks: target === 'completed' ? f.step('A-01').conditions.map(item => ({ ...item, result: 'passed', evidenceIds: ['matrix'] })) : [] };
    const allowed = from === target || transitions[from].includes(target);
    try { await f.update('A-01', target, extra); assert.equal(allowed, true, `${from}/${target}`); results.push({ from, target, accepted: true }); }
    catch (error) { assert.equal(allowed, false, `${from}/${target}: ${error.message}`); results.push({ from, target, accepted: false, code: error.code }); }
    await f.persistence.run(() => f.persistence.write('light', initial));
  }
  await f.evidence('B25-transitions', { results });
});

test('B-03 完成条件不可删改、证据修订、显式返工、前置取消及后继影响', async t => {
  const f = await fixture(t);
  await f.update('A-01', 'running');
  await assert.rejects(f.update('A-01', 'completed'), /INVALID_INPUT/);
  const proof = { evidenceId: 'bad', location: 'fixture://bad', method: '检查', deliveryVersion: 'v1', result: 'passed' };
  await assert.rejects(f.update('A-01', 'completed', { evidence: [proof], checks: [{ ...f.step('A-01').conditions[0], conditionId: 'invented', result: 'passed', evidenceIds: ['bad'] }] }), /EVIDENCE_MISMATCH/);
  await f.finish('A-01'); await f.finish('A-01', 'fixture-v2');
  await f.update('A-02', 'running'); await f.finish('A-02');
  await assert.rejects(f.update('A-01', 'running'), /REOPEN_REQUIRED/);
  await f.update('A-01', 'running', { reopen: { reason: '交付修订', successorImpact: 'A-02 重新复核' } });
  assert.equal(f.step('A-02').status, 'blocked'); assert.equal(f.step('A-02').acceptance, 'recheck');
  assert.ok(f.snapshot().events.some(item => item.toStatus === 'completed'));
  await f.update('A-01', 'cancelled', { successorImpact: 'A-02 等待替代承接' });
  await assert.rejects(f.update('A-02', 'running', { reopen: { reason: '复核后继', successorImpact: '核对前置' } }), /DEPENDENCY_NOT_READY|BLOCKER_NOT_RESOLVED/);
  await f.evidence('B-status-evidence-reopen');
});

test('B-05 幂等回放先于版本/绑定、异内容拒绝及并发冲突', async t => {
  let allowed = true;
  const f = await fixture(t, { authorize: () => allowed });
  await f.update('A-01', 'running');
  const input = f.transcript.at(-1).input;
  const expected = f.transcript.at(-1).result;
  await f.update('A-01', 'running');
  assert.deepEqual(await f.call('update', input), expected);
  await assert.rejects(f.call('update', { ...input, reason: 'different' }), /IDEMPOTENCY_CONFLICT/);
  const fresh = { ...input, ...f.base('concurrent') };
  const competing = { ...fresh, eventId: 'competing' };
  const values = await Promise.allSettled([f.call('update', fresh), f.call('update', competing)]);
  assert.equal(values.filter(item => item.status === 'fulfilled').length, 1);
  assert.match(values.find(item => item.status === 'rejected').reason.message, /REVISION_CONFLICT/);
  await f.persistence.run(() => { const value = f.persistence.read('light'); value.snapshot.bindings[0].state = 'revoked'; value.snapshot.bindings[0].revokedAt = '2026-11-10T22:00:00+08:00'; f.persistence.write('light', value); });
  assert.deepEqual(await f.call('update', input), expected);
  await assert.rejects(f.call('update', { ...input, ...f.base('after-revoke') }), /STALE_BINDING/);
  allowed = false; assert.throws(() => f.service.query('fixture-owner', f.projectId, 'update', input.eventId), /FORBIDDEN/);
  allowed = true; await f.restart(); assert.deepEqual(await f.call('update', input), expected);
  let release;
  const held = f.persistence.run(() => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const queued = f.call('update', input);
  allowed = false; release(); await held;
  await assert.rejects(queued, /FORBIDDEN/); allowed = true;
  await f.evidence('B-idempotency-conflict');
});

test('B-05 发送侧响应丢失、重启查询或原请求重放、空缺身份保留', async t => {
  const f = await fixture(t);
  const request = { ...f.base('outbox'), eventId: 'outbox-event' };
  await f.outbox.enqueue('owner', 'reserveExecution', request, { bindingId: null });
  const persisted = f.outbox.list('owner')[0]; assert.equal(persisted.receivedAt, null); assert.equal(persisted.committedRevision, null);
  await assert.rejects(f.outbox.enqueue('owner', 'reserveExecution', { ...request, reason: 'changed' }), /IDEMPOTENCY_CONFLICT/);
  let sends = 0;
  const transport = { send: async input => { sends++; await f.call('reserveExecutionId', input); throw Error('response lost'); },
    query: async () => f.service.query('fixture-owner', f.projectId, 'reserveExecution', request.eventId) };
  assert.equal((await f.outbox.synchronize('owner', 'reserveExecution', request.eventId, transport)).sync, 'unknown');
  await f.restart();
  assert.equal((await f.outbox.synchronize('owner', 'reserveExecution', request.eventId, transport)).sync, 'synced'); assert.equal(sends, 1);
  const replay = { ...f.base('replay-outbox') };
  await f.outbox.enqueue('owner', 'reserveExecution', replay);
  await f.outbox.synchronize('owner', 'reserveExecution', replay.eventId, { send: async input => { await f.call('reserveExecutionId', input); throw Error('lost'); } });
  await f.restart();
  assert.equal((await f.outbox.synchronize('owner', 'reserveExecution', replay.eventId, { send: input => f.call('reserveExecutionId', input) })).sync, 'synced');
  await f.outbox.enqueue('local', 'candidate', { eventId: 'unregistered', projectId: null });
  assert.equal(f.outbox.list('local')[0].serviceProjectId, null);
  await f.evidence('B-outbox', { outbox: f.outbox.list('owner') });
});

test('B-06 聚合故障注入覆盖磁盘失败、准备中断、提交标志后恢复', async t => {
  let point = null;
  const f = await fixture(t, { fault: async stage => { if (stage === point) { const error = Error('injected disk or interruption'); error.code = 'ENOSPC'; throw error; } } });
  for (const stage of ['beforePrepare', 'prepared', 'committed', 'installed']) {
    const before = f.persistence.read('light'); const audit = f.persistence.read('audit').length;
    const request = f.base(`fault-${stage}`); point = stage;
    await assert.rejects(f.call('reserveExecutionId', request), /injected/);
    if (['committed', 'installed'].includes(stage)) assert.throws(() => f.snapshot(), /RECOVERY_REQUIRED/);
    else assert.deepEqual(f.persistence.read('light'), before);
    point = null; await f.restart();
    const query = f.service.query('fixture-owner', f.projectId, 'reserveExecution', request.eventId);
    if (['committed', 'installed'].includes(stage)) {
      assert.equal(query.state, 'committed'); assert.equal(f.snapshot().projects[0].revision, before.snapshot.projects[0].revision + 1);
      assert.equal(f.persistence.read('audit').length, audit + 1);
    } else { assert.equal(query.state, 'unknown'); assert.equal(f.persistence.read('audit').length, audit); }
  }
  await f.evidence('B-fault-injection');
});

test('B-06 旧库保留、原状态与待核验、repairId、备份恢复及普通启动入口', async t => {
  const f = await fixture(t);
  const legacy = oldModel(); legacy.stations[0].report = { status: 'done' }; legacy.business = { repairs: [{ repairId: 'old-repair' }] };
  await f.persistence.run(() => {
    f.persistence.write('projects', { version: 1, projects: [{ ...oldProject, revision: 1, createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z' }] });
    f.persistence.write('models', { [oldProject.id]: { revision: 1, model: legacy } });
  });
  const before = f.persistence.read('models');
  await f.call('retainLegacy', { ...f.base('legacy'), legacyProjectId: oldProject.id });
  assert.deepEqual(f.persistence.read('models'), before);
  assert.deepEqual(legacyLightStatus({ report: { status: 'done' } }), { status: 'running', acceptance: 'pending' });
  assert.equal(legacyLightStatus({ report: { status: 'todo' }, status: 'pending' }).status, 'pending');
  assert.equal(legacyLightStatus({ id: 'historical', status: 'pending' }, { lifecycle: { starts: [{ stationId: 'historical' }] } }).status, 'running');
  await f.restart();
  const state = f.persistence.read('light'); assert.deepEqual(state.metadata[digest(state.snapshot.projects[0].key)].legacy.repairIds, ['old-repair']);
  const backup = path.join(f.root, 'explicit-backup.json'); await cp(path.join(f.root, 'aggregate.json'), backup);
  await f.call('reserveExecutionId', f.base('after-backup'));
  await cp(backup, path.join(f.root, 'aggregate.json')); await f.restart(); assert.deepEqual(f.persistence.read('light'), state);
  const server = await createServer({ dataDir: f.root, env: {}, lightAuthorize: () => true });
  assert.deepEqual(server.workbench.light.read('fixture-owner', f.projectId), f.snapshot());
  await new Promise(resolve => { server.once('close', resolve); server.close(); });
  await f.evidence('B-legacy-backup');
});

test('B-02/03 父阶段继承门禁、必要细分与阶段出口共同聚合，循环拒绝', async t => {
  const input = candidate();
  const child = structuredClone(input.steps[0]);
  child.key += '/children/A-01-01'; child.parentKey = input.steps[0].key; child.code = 'A-01-01';
  child.conditions[0].conditionId = child.key + '/exit'; child.order = 1;
  input.steps.push(child);
  const f = await fixture(t, { candidate: input });
  await assert.rejects(f.update(child.code, 'running'), /DEPENDENCY_NOT_READY/);
  await f.update('A-01', 'running');
  await assert.rejects(f.finish('A-01'), /DEPENDENCY_NOT_READY/);
  await assert.rejects(f.update('A-02', 'running'), /DEPENDENCY_NOT_READY/);
  await f.update(child.code, 'running'); await f.finish(child.code); await f.finish('A-01');
  await f.update('A-02', 'running');
  const cycle = structuredClone(input); cycle.steps.at(-1).dependsOn = [input.steps[0].key];
  assert.throws(() => validateLightSnapshot(cycle), /DEPENDENCY_CYCLE/);
  const duplicate = binding(f.snapshot(), [child.key]);
  duplicate.key += '-second';
  await assert.rejects(f.call('acceptBinding', { ...f.base(), binding: duplicate }), /DUPLICATE_OWNER/);
  await f.evidence('B-hierarchy');
});

test('B-04 补充事项规划、原 repairId、多个阻塞仅按对应来源解除', async t => {
  const input = candidate();
  const linked = candidate('supplement-delivery');
  const projectKey = input.projects[0].key;
  for (const group of ['plans', 'steps', 'routes']) for (const item of linked[group]) item.projectKey = projectKey;
  input.projects[0].planKeys.push(linked.plans[0].key);
  input.plans.push(...linked.plans); input.steps.push(...linked.steps); input.routes.push(...linked.routes);
  // 补充方案使用单个独立交付步骤。
  const linkedKeys = new Set(linked.steps.slice(1).map(item => item.key));
  input.steps = input.steps.filter(item => !linkedKeys.has(item.key));
  input.routes = input.routes.filter(item => item.planKey !== linked.plans[0].key);
  input.routes.push({ ...linked.routes[0], stepKeys: [linked.steps[0].key] });
  input.plans[1].stageKeys = [linked.steps[0].key]; input.plans[1].stageCount = 1;
  // 编号在方案作用域内唯一，测试辅助按 code 选择时区分此独立步骤。
  input.steps.at(-1).code = 'S'; input.steps.at(-1).originalCode = 'S';
  const f = await fixture(t, { candidate: input });
  await f.update('A-01', 'running');
  const manual = { blockerId: 'external', reason: '仍等待外部', waitingFor: ['外部模块'], releaseConditions: ['外部处理'], resolved: false };
  await f.update('A-01', 'blocked', { blocker: manual });
  const source = f.step('A-01');
  const request = { ...f.base('supp-create'), action: 'create', supplementId: null, sourceStepId: source.id, title: '独立补充', goal: '完成独立交付',
    blocksSource: true, status: 'unconfirmed', linkedPlanId: null, repairId: 'historical-repair-17', evidence: [] };
  const created = await f.call('supplement', request);
  assert.deepEqual(await f.call('supplement', request), created);
  const second = await f.call('supplement', { ...request, ...f.base('supp-second'), repairId: null });
  const supplement = (action, extra = {}) => ({ ...request, ...f.base(), action, supplementId: created.supplementId, ...extra });
  const linkedPlan = f.snapshot().plans[1];
  await assert.rejects(f.call('supplement', supplement('linkPlan', { linkedPlanId: linkedPlan.id })), /CONFIRMATION_REQUIRED/);
  await f.call('supplement', supplement('update', { status: 'unplanned' }));
  await f.call('supplement', supplement('linkPlan', { linkedPlanId: linkedPlan.id }));
  const proof = { evidenceId: 'supp-proof', location: 'fixture://supp', method: '实际领域回读', deliveryVersion: 'supp-v1', result: 'passed' };
  await assert.rejects(f.call('supplement', supplement('resolve', { status: 'completed', linkedPlanId: linkedPlan.id, evidence: [proof] })), /EVIDENCE_MISMATCH/);
  // 关联方案使用其自己的绑定与执行身份。
  const snapshot = f.snapshot(); const linkedStep = snapshot.steps.find(item => item.planKey === linkedPlan.key);
  const linkedBinding = { ...binding(snapshot, [linkedStep.key]), key: linkedPlan.key + '/binding', planKey: linkedPlan.key };
  await f.call('acceptBinding', { ...f.base(), planId: linkedPlan.id, binding: linkedBinding });
  const execution = await f.call('reserveExecutionId', { ...f.base(), planId: linkedPlan.id });
  const update = { ...f.base(), planId: linkedPlan.id, stepId: linkedStep.id, executionId: execution.executionId,
    bindingId: linkedBinding.id, bindingRevision: 1, targetStatus: 'running', evidence: [], checks: [], blocker: null, reopen: null, successorImpact: null };
  await f.call('update', update);
  await f.call('update', { ...update, ...f.base(), planId: linkedPlan.id, targetStatus: 'completed', evidence: [proof],
    checks: linkedStep.conditions.map(item => ({ ...item, result: 'passed', evidenceIds: [proof.evidenceId] })) });
  await f.call('supplement', supplement('resolve', { status: 'completed', linkedPlanId: linkedPlan.id, evidence: [proof] }));
  assert.equal(f.step('A-01').status, 'blocked');
  assert.equal(f.step('A-01').blockers.filter(item => !item.resolved).length, 2);
  await f.call('supplement', { ...supplement('cancel', { status: 'cancelled', reason: '用户取消，改由来源步骤原验收承接' }), supplementId: second.supplementId });
  assert.equal(f.step('A-01').blockers.filter(item => !item.resolved).length, 1);
  await f.update('A-01', 'running', { blocker: { ...manual, resolved: true } });
  assert.equal(f.snapshot().supplements[0].repairId, 'historical-repair-17');
  assert.equal(f.step('A-01').acceptance, 'pending');
  await f.finish('A-01'); await f.update('A-02', 'running');
  const dependentRequest = { ...request, ...f.base(), sourceStepId: f.step('A-02').id, repairId: null };
  const dependentSupplement = await f.call('supplement', dependentRequest);
  await f.update('A-01', 'running', { reopen: { reason: '前置返工', successorImpact: 'A-02 等待前置重验' } });
  await f.call('supplement', { ...dependentRequest, ...f.base(), action: 'cancel', supplementId: dependentSupplement.supplementId,
    status: 'cancelled', reason: '批准取消，来源步骤验收承接' });
  assert.equal(f.step('A-02').status, 'blocked');
  assert.ok(f.step('A-02').blockers.some(blocker => blocker.blockerId.startsWith('dependency:') && !blocker.resolved));
  await f.restart(); await f.evidence('B-supplements');
});

test('B-02/03 修订保留身份和差异，取消必要步骤需批准替代承接', async t => {
  const f = await fixture(t);
  await f.update('A-01', 'cancelled', { successorImpact: 'A-02 等待批准替代' });
  await assert.rejects(f.update('A-02', 'running'), /DEPENDENCY_NOT_READY/);
  await assert.rejects(f.call('replaceCancelled', { ...f.base(), sourceStepId: f.step('A-01').id, replacementStepIds: [f.step('A-04').id] }), /INVALID_INPUT/);
  await f.call('replaceCancelled', { ...f.base(), sourceStepId: f.step('A-01').id, replacementStepIds: [f.step('A-04').id], approvalRef: 'isolated-user-approved-replacement' });
  await assert.rejects(f.update('A-02', 'running'), /DEPENDENCY_NOT_READY/);
  await f.update('A-04', 'running'); await f.finish('A-04'); await f.update('A-02', 'running');
  const oldId = f.step('A-02').id;
  const revised = f.snapshot(); revised.mode = 'simulation';
  const inserted = structuredClone(revised.steps[0]); inserted.key = revised.plans[0].key + '/steps/A-02-a'; inserted.id = null;
  inserted.code = 'A-02-a'; inserted.originalCode = '插入目标'; inserted.order = 21; inserted.required = true; inserted.status = 'pending'; inserted.evidence = [];
  inserted.conditions = [{ ...inserted.conditions[0], conditionId: inserted.key + '/exit', result: 'pending', evidenceIds: [] }];
  inserted.bindingKey = null; inserted.executionKey = null; inserted.blockers = [];
  revised.steps.push(inserted); revised.plans[0].stageKeys.push(inserted.key); revised.plans[0].stageCount++;
  revised.routes.push({ ...revised.routes[0], key: revised.plans[0].key + '/routes/inserted', id: null, stepKeys: [inserted.key], order: 7 });
  revised.bindings = []; revised.executions = []; revised.events = [];
  for (const step of revised.steps) { step.executionKey = null; step.bindingKey = null; }
  const changedExit = revised.steps.find(step => step.code === 'A-04');
  changedExit.conditions.push({ conditionId: 'new-required-exit', text: '修订新增验收', required: true, result: 'pending', evidenceIds: [] });
  changedExit.status = 'pending'; changedExit.acceptance = 'pending';
  await f.call('revise', { ...f.base(), snapshot: revised });
  assert.equal(f.step('A-02').id, oldId); assert.equal(f.step('A-02-a').originalCode, '插入目标');
  assert.equal(f.step('A-04').status, 'blocked'); assert.equal(f.step('A-04').conditions.at(-1).text, '修订新增验收');
  const deleted = f.snapshot(); deleted.steps = deleted.steps.filter(item => item.id !== oldId);
  await assert.rejects(f.call('revise', { ...f.base(), snapshot: deleted }));
  await f.restart(); await f.evidence('B-revision-replacement');
});

test('B-06 子进程在准备与提交标志处退出，重开恢复原子业务、事件和审计', async t => {
  const f = await fixture(t);
  const outcomes = [];
  for (const stage of ['prepared', 'committed']) {
    const request = f.base('process-' + stage);
    const requestFile = path.join(f.root, 'crash-request.json'); await writeFile(requestFile, JSON.stringify(request), 'utf8');
    const script = `import fs from 'node:fs';
      import {createPersistence} from './server/persistence.mjs';
      import {createRequests} from './server/business-requests.mjs';
      import {createLightService} from './server/light-service.mjs';
      const p=await createPersistence(process.env.B_CRASH_ROOT,{fault:async point=>{if(point===process.env.B_CRASH_POINT)process.exit(73)}});
      const s=createLightService(p,createRequests(p),{authorize:()=>true});
      await s.reserveExecutionId('fixture-owner',JSON.parse(fs.readFileSync(process.env.B_CRASH_REQUEST,'utf8')));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url),
      env: { ...process.env, B_CRASH_ROOT: f.root, B_CRASH_POINT: stage, B_CRASH_REQUEST: requestFile }, encoding: 'utf8' });
    assert.equal(result.status, 73, result.stderr);
    await f.restart();
    const query = f.service.query('fixture-owner', f.projectId, 'reserveExecution', request.eventId);
    assert.equal(query.state, stage === 'prepared' ? 'unknown' : 'committed');
    outcomes.push({ stage, exitCode: result.status, state: query.state });
  }
  await f.evidence('B-process-crash', { outcomes });
});

test('B-05/06 实际文件目标失败保持旧可读版本，发送并发迟到失败不回退成功', async t => {
  const f = await fixture(t);
  const previous = f.persistence.read('light');
  const backup = path.join(f.root, 'aggregate.json.bak');
  await rm(backup); await mkdir(backup);
  await assert.rejects(f.call('reserveExecutionId', f.base('filesystem-failure')), /EISDIR|EPERM|EEXIST|ENOTEMPTY/);
  assert.deepEqual(f.persistence.read('light'), previous);
  await rmdir(backup); await f.restart(); assert.deepEqual(f.persistence.read('light'), previous);
  const request = f.base('outbox-concurrent');
  await f.outbox.enqueue('sender', 'reserveExecution', request);
  let release;
  const lateFailure = new Promise(resolve => { release = resolve; });
  const slow = f.outbox.synchronize('sender', 'reserveExecution', request.eventId, { send: async () => { await lateFailure; throw Error('late lost response'); } });
  const fast = await f.outbox.synchronize('sender', 'reserveExecution', request.eventId, { send: input => f.call('reserveExecutionId', input) });
  assert.equal(fast.sync, 'synced'); release(); assert.equal((await slow).sync, 'synced');
  await assert.rejects(f.outbox.prepare('sender', 'reserveExecution', request.eventId, request), /RESULT_UNKNOWN/);
  await f.evidence('B-filesystem-outbox-concurrency');
});

test('B-02/04/05 三十站规模、项目隔离、跨方案授权闭包及阅读定位持久保存', async t => {
  const input = candidate();
  for (let number = 21; number <= 30; number++) {
    const previous = input.steps.at(-1), step = structuredClone(previous);
    step.key = `${input.plans[0].key}/steps/A-${number}`; step.code = `A-${number}`; step.originalCode = `A-${number}`;
    step.order = number; step.dependsOn = [previous.key]; step.conditions[0].conditionId = step.key + '/exit';
    input.steps.push(step); input.plans[0].stageKeys.push(step.key); input.routes.at(-1).stepKeys.push(step.key);
  }
  input.plans[0].stageCount = 30;
  const f = await fixture(t, { candidate: input });
  const other = await f.call('register', { eventId: 'register', expectedRevision: 0, snapshot: candidate('other-project') });
  assert.equal(f.snapshot().steps.length, 30);
  const preference = { collapsedKeys: [f.step('A-01').key], selectedStepKey: f.step('A-04').key,
    focusedRouteKey: f.snapshot().routes[1].key, scrollByProject: { [f.snapshot().projects[0].key]: { x: 4, y: 80 } } };
  await f.call('savePreferences', { ...f.base('preferences'), uiPreferences: preference });
  await f.update('A-01', 'running');
  assert.deepEqual(f.snapshot().uiPreferences, preference);
  const request = { ...f.base('cross-supplement'), action: 'create', supplementId: null, sourceStepId: f.step('A-01').id,
    title: '跨项目关联', goal: '独立交付', blocksSource: true, status: 'unconfirmed', linkedPlanId: null, repairId: null, evidence: [] };
  const created = await f.call('supplement', request);
  await f.call('supplement', { ...request, ...f.base(), action: 'update', supplementId: created.supplementId, status: 'unplanned' });
  await f.call('supplement', { ...request, ...f.base(), action: 'linkPlan', supplementId: created.supplementId, linkedPlanId: other.planIds[0] });
  assert.equal(f.snapshot().projects.length, 2); assert.equal(f.snapshot().steps.length, 50);
  await f.restart(); assert.deepEqual(f.snapshot().uiPreferences, preference);
  await f.evidence('B-scale-projects-preferences');
});
