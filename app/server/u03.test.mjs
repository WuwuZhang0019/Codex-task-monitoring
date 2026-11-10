import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import {fileURLToPath} from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { contractFingerprint } from './business-schema.mjs';
import { createServer } from './index.mjs';
import { createStore } from './store.mjs';
import { createModelStore } from './model-store.mjs';
import { draftInput, workContext, actorDeclaration } from '../tests/helpers/u03-fixture.mjs';
import { migrate } from '../desktop/migrate.mjs';
import { inspectMonitor, reconcileLifecycle } from './monitor.mjs';
import { model as legacyFixture, complete, project as legacyProject } from '../tests/helpers/output-fixture.mjs';

const timestamp = '2026-11-10T03:40:00Z';
async function fixture(t, config = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'u03-'));
  let server, origin;
  async function start() { server = await createServer({ dataDir: root, env: {}, ...config }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`; }
  async function stop() { if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } }
  await start();
  t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
  const transcript = [];
  async function request(endpoint, body, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(origin + '/api' + endpoint, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json(); transcript.push({ endpoint, method, input: body, status: response.status, result: value });
    return { status: response.status, value };
  }
  async function ok(endpoint, body, method) { const result = await request(endpoint, body, method); assert.ok(result.status < 300, JSON.stringify(result)); return result.value; }
  async function publish(input = draftInput()) {
    const draft = await ok('/import-drafts', input);
    assert.equal(draft.status, 'ready', JSON.stringify(draft.issues));
    const confirmation = await ok(`/import-drafts/${draft.draftId}/confirm`, { revision: draft.revision, expectedRevision: input.targetProjectId ? (await ok(`/projects/${input.targetProjectId}/model`)).revision : 0, acknowledged: true });
    const body = { confirmationGrantId: confirmation.confirmationGrantId, confirmationDigest: confirmation.confirmationDigest, sourceHash: draft.source.sourceHash, idempotencyKey: `publish-${draft.draftId}` };
    const publication = await ok(`/import-drafts/${draft.draftId}/publish`, body);
    return { draft, body, publication };
  }
  async function evidence(name) {
    if (process.env.U03_EVIDENCE_DIR) { await mkdir(process.env.U03_EVIDENCE_DIR, { recursive: true }); await writeFile(path.join(process.env.U03_EVIDENCE_DIR, name + '.json'), JSON.stringify({ date: '2026-11-10', root, nodeVersion: process.version, transcript }, null, 2)); }
  }
  return { root, start, stop, request, ok, publish, evidence, get core() { return server.workbench; } };
}

async function executionFixture(t) {
  const f = await fixture(t), { publication } = await f.publish();
  const projectId = publication.projectId, endpoint = `/projects/${projectId}`;
  let value = await f.ok(endpoint + '/model');
  const station = value.model.stations[0], task = value.model.tasks[0];
  value.model.chats = ['chat1', 'chat2'].map(id => ({ id, taskId: task.id, folderId: task.folderId, externalId: `fixed-${id}` }));
  await f.ok(endpoint + '/model', value, 'PUT');
  async function command(operation, body) {
    const latest = await f.ok(endpoint + '/model');
    return f.ok(endpoint + '/business', { operation, expectedRevision: latest.revision, idempotencyKey: crypto.randomUUID(), ...body });
  }
  const bindings = [];
  for (const sourceId of ['chat1', 'chat2']) bindings.push((await command('bind', { taskId: task.id, stationId: station.id, sourceId, provider: 'fixture', hostId: 'fixture-host', dataRootId: 'fixture-root', sessionId: sourceId, threadId: null, confirmationRef: '固定输入用户确认', workContext })).binding);
  function scope(binding, executionId = 'not-started') { return { projectId, folderId: task.folderId, taskId: task.id, stationId: station.id, planId: publication.planId, sourceId: binding.sourceId, bindingId: binding.bindingId, bindingRevision: binding.bindingRevision, executionId }; }
  const claim = await command('claim', { scope: scope(bindings[0]), workContext, allowedPaths: [], reason: '固定范围首次认领' });
  const execution = await command('start', { schemaVersion: '1.0.0', projectId, actorDeclaration, scope: scope(bindings[0]), workContext, startedAt: timestamp, evidence: '隔离执行实际开始' });
  return { ...f, projectId, endpoint, station, task, bindings, scope, command, claim, execution };
}

test('U03-K01 原文出处、集中补缺、完整模型、原子发布与全部读取入口', async t => {
  assert.equal(contractFingerprint, createHash('sha256').update(await readFile(new URL('../mcp/contracts/v1.json', import.meta.url))).digest('hex'));
  const f = await fixture(t), input = draftInput();
  assert.throws(() => f.core.drafts.get('constructor'), /草稿不存在/);
  const broken = structuredClone(input); broken.candidate.goal = null; broken.candidate.provenance[0].excerpt = '不存在的摘录'; broken.candidate.requirements[0].conditionIds = [];
  const draft = await f.ok('/import-drafts', broken);
  assert.equal(draft.status, 'needs-review'); assert.ok(draft.issues.filter(i => i.blocking).length >= 3);
  assert.equal((await f.request(`/import-drafts/${draft.draftId}/confirm`, { revision: 1, expectedRevision: 0, acknowledged: true })).status, 400);
  assert.deepEqual((await f.ok('/projects')).projects, []);
  const forbidden = structuredClone(input); forbidden.candidate.receiptLog = { reviews: [{ passed: true }] };
  assert.equal((await f.request('/import-drafts', forbidden)).status, 400);
  const corrected = await f.ok(`/import-drafts/${draft.draftId}`, { ...input, idempotencyKey: 'correction', expectedRevision: 1 }, 'PUT');
  assert.equal(corrected.status, 'ready'); assert.equal(corrected.revision, 2); assert.deepEqual(corrected.entityIds, draft.entityIds);
  assert.equal(corrected.history.length, 1);
  const validation = await f.ok(`/import-drafts/${draft.draftId}/validate`, {});
  assert.equal(validation.basisRevision, 0); assert.equal(validation.diff.after.stations.length, 8);
  const confirmation = await f.ok(`/import-drafts/${draft.draftId}/confirm`, { revision: 2, expectedRevision: 0, acknowledged: true });
  const publishBody = { confirmationGrantId: confirmation.confirmationGrantId, confirmationDigest: confirmation.confirmationDigest, sourceHash: corrected.source.sourceHash, idempotencyKey: 'publish-same' };
  const results = await Promise.all(Array.from({ length: 6 }, () => f.ok(`/import-drafts/${draft.draftId}/publish`, publishBody)));
  assert.equal(new Set(results.map(r => r.publicationId)).size, 1);
  const publication = results[0], id = publication.projectId;
  assert.equal((await f.ok('/projects')).projects.length, 1);
  const project = (await f.ok(`/projects/${id}`)).project, model = await f.ok(`/projects/${id}/model`), monitor = await f.ok(`/projects/${id}/monitor`);
  assert.equal(project.steps.length, 8); assert.equal(model.model.stations.length, 8); assert.equal(model.model.chats.length, 0);
  assert.ok(monitor.stations.every(s => s.color === 'dark')); assert.equal(monitor.resumeContext.mainStationCount, 8);
  const output = await f.ok(`/projects/${id}/outputs`, { stationId: model.model.stations[0].id });
  assert.match(output.audit.text, /共 8 步/); assert.equal(output.basisRevision, monitor.revision);
  const saved = await f.ok(`/import-drafts/${draft.draftId}`); assert.equal(saved.status, 'committed');
  const query = await f.ok('/requests', { projectId: draft.draftId, operation: 'draft.publish', idempotencyKey: 'publish-same' });
  assert.equal(query.state, 'committed'); assert.equal(query.requestId, publication.requestId);
  assert.equal((await f.request(`/import-drafts/${draft.draftId}/publish`, { ...publishBody, sourceHash: 'f'.repeat(64) })).status, 409);
  await f.stop(); await f.start(); assert.deepEqual(await f.ok(`/projects/${id}/model`), model);
  await f.evidence('K01-publication');
});

test('U03-K01 非法依赖、缺失步骤、出处范围和覆盖映射阻止发布', async t => {
  const f = await fixture(t);
  const mutations = [c => c.stations[0].dependsOn.push('missing'), c => c.stations[0].code = c.stations[1].code, c => { c.stations[0].dependsOn = ['s2']; c.stations[1].dependsOn = ['s1']; }, c => c.declaredStepCount = 7, c => c.stations.pop(), c => c.requirements[0].conditionIds = ['k2']];
  for (const mutate of mutations) {
    const input = draftInput(); input.idempotencyKey = crypto.randomUUID(); mutate(input.candidate);
    const draft = await f.ok('/import-drafts', input); assert.equal(draft.status, 'needs-review');
    assert.equal((await f.request(`/import-drafts/${draft.draftId}/confirm`, { revision: draft.revision, expectedRevision: 0, acknowledged: true })).status, 400);
  }
  assert.equal((await f.ok('/projects')).projects.length, 0);
  await f.evidence('K01-rejections');
});

test('U03-K02 修复轮次、中断、原键重试、跨聊续接、重开与原条件回归', async t => {
  const f = await executionFixture(t), { projectId, station, bindings, scope, execution } = f;
  const base = binding => ({ schemaVersion: '1.0.0', projectId, actorDeclaration, scope: scope(binding, execution.executionId) });
  await f.command('receipt', { ...base(bindings[0]), workContext, deliveryVersion: 'v0', actual: '首次交付失败', raw: '固定首次回执', checks: [], evidence: [], unresolved: ['原条件尚未满足'], endedAt: timestamp, outcome: 'failed', next: [] });
  let model = await f.ok(f.endpoint + '/model');
  const returnAnchor = { projectId, taskId: station.taskId, stationId: station.id, planId: station.planId, conditionIds: ['k1'], dependencyStationIds: [], successorStationIds: [], mergeStationIds: [], basisRevision: model.revision };
  const repair = await f.command('repair', { ...base(bindings[0]), action: 'createCase', case: { triggerReceiptId: null, failedConditionIds: ['k1'], problem: '原条件未满足', expectedResult: '按原条件交付', scopeClass: 'requiredRepair', closeConditions: ['k1'], returnAnchor } });
  const attempts = [];
  for (let i = 0; i < 2; i++) {
    const attempt = await f.command('repair', { ...base(bindings[0]), action: 'appendAttempt', repairId: repair.repairId, attempt: { goal: '满足原条件', method: `固定方法${i + 1}`, workContext, startedAt: timestamp } });
    attempts.push(attempt);
    await f.command('repair', { ...base(bindings[0]), scope: scope(bindings[0], attempt.executionId), action: 'submitResolutionCandidate', repairId: repair.repairId, attemptId: attempt.attemptId,
      resolution: { deliveryVersion: `v${i + 1}`, checks: [], evidence: [], unresolved: ['同一剩余差距'], endedAt: timestamp, outcome: i === 0 ? 'failed' : 'interrupted' } });
  }
  let context = await f.ok(f.endpoint + '/business');
  assert.equal(context.repairRounds, 2); assert.equal(context.mainStationCount, 8); assert.equal(context.repairs[0].interrupted, 1); assert.equal(context.repairs[0].failed, 1); assert.equal(context.repairs[0].reassessmentSuggested, true);
  const third = await f.command('repair', { ...base(bindings[0]), action: 'appendAttempt', repairId: repair.repairId, attempt: { goal: '完成证据交付', method: '第三次受控重验', workContext, startedAt: timestamp } });
  await f.command('takeover', { scope: scope(bindings[1], third.executionId), workContext, allowedPaths: [], reason: '同一轮换聊续接' });
  const oldReceipt = { ...base(bindings[0]), scope: scope(bindings[0], third.executionId), workContext, deliveryVersion: 'late', actual: '旧来源迟到', raw: '旧来源迟到结果', checks: [], evidence: [], unresolved: [], endedAt: timestamp, outcome: 'delivered', next: [] };
  const late = await f.command('receipt', oldReceipt); assert.equal(late.historicalOnly, true);
  context = await f.ok(f.endpoint + '/business'); assert.equal(context.repairRounds, 3); assert.equal(context.repairs[0].attempts[2].outcome, 'running');
  const delivery = { ...base(bindings[1]), scope: scope(bindings[1], third.executionId), workContext, deliveryVersion: 'v3', actual: '完成原条件产物', raw: '本轮固定真实回执', checks: [{ conditionId: 'k1', result: 'passed', evidenceIds: ['e3'], reason: '执行自检' }], evidence: [], unresolved: [], repairId: repair.repairId, attemptId: third.attemptId, endedAt: timestamp, outcome: 'delivered', next: [] };
  const receipt = await f.command('receipt', delivery);
  context = await f.ok(f.endpoint + '/business'); assert.equal(context.repairs[0].status, 'pendingReview'); assert.equal(context.disposition, 'wait_verification');
  const review = { reviewer: '隔离人工核验人', method: '核对固定产物', checks: [{ criterion: station.acceptance[0], result: 'passed', reason: '核对隔离证据及版本', evidenceIds: ['e3'] }], taskChecks: [], projectChecks: [], evidence: [{ id: 'e3', location: 'fixed-result.json', deliveryVersion: 'v3', method: '读取固定输入', reason: '固定版本匹配', result: 'valid' }], handoffs: [] };
  model = await f.ok(f.endpoint + '/model'); await f.ok(f.endpoint + '/receipts', { revision: model.revision, action: 'review', receiptId: receipt.receiptId, review });
  context = await f.ok(f.endpoint + '/business'); assert.equal(context.repairs[0].status, 'resolved'); assert.equal(context.unresolvedCases, 0);
  await f.command('reopen', { repairId: repair.repairId, reason: '固定回归发现新失败' });
  context = await f.ok(f.endpoint + '/business'); assert.equal(context.repairs[0].status, 'recheck'); assert.equal(context.repairRounds, 3); assert.equal(context.returnAnchors[0].stationId, station.id);
  await f.stop(); await f.start(); assert.deepEqual(await f.ok(f.endpoint + '/business'), context);
  const revision = (await f.ok(f.endpoint + '/model')).revision;
  const duplicate = await f.command('repair', { ...base(bindings[1]), scope:scope(bindings[1],third.executionId), action: 'createCase', case: { triggerReceiptId: null, failedConditionIds: ['k1'], problem: '重复归档案例', expectedResult: '按同一原条件交付', scopeClass: 'requiredRepair', closeConditions: ['k1'], returnAnchor: { ...returnAnchor, basisRevision: revision } } });
  const extra = await f.command('repair', { ...base(bindings[1]), action: 'appendAttempt', repairId: duplicate.repairId, attempt: { goal: '保留重复案例的尝试', method: '重复案例固定方法', workContext, startedAt: timestamp } });
  await f.command('repair', { ...base(bindings[1]), scope: scope(bindings[1], extra.executionId), action: 'submitResolutionCandidate', repairId: duplicate.repairId, attemptId: extra.attemptId, resolution: { deliveryVersion: 'v4', checks: [], evidence: [], unresolved: ['仍需回归原条件'], endedAt: timestamp, outcome: 'interrupted' } });
  await f.command('merge', { repairId: repair.repairId, duplicateRepairId: duplicate.repairId, reason: '同问题去重，保留原 ID 和轮次' });
  await f.command('reassess', { repairId: repair.repairId, decision: 'changeMethod', threshold: 2, reason: '隔离用户确认按原标准更换方法' });
  context = await f.ok(f.endpoint + '/business'); assert.equal(context.repairs.length, 1); assert.equal(context.repairRounds, 4); assert.deepEqual(context.repairs[0].mergedCaseIds, [duplicate.repairId]); assert.equal(context.repairs[0].reassessmentDecision.decision, 'changeMethod');
  await f.evidence('K02-repair-resume');
});

test('U03-K03 覆盖、站内细化、新范围、并行冲突与过期建议', async t => {
  const f = await executionFixture(t);
  const snapshot = await f.ok(f.endpoint + '/model');
  await f.command('refine', { stationId: f.station.id, conditionIds: ['k1'], title: '本站内部实现', goal: '细化到原验收', changesContract: false });
  await f.command('scopeCandidate', { stationId: f.station.id, title: '额外优化', reason: '原范围之外' });
  const context = await f.ok(f.endpoint + '/business'); assert.equal(context.mainStationCount, 8); assert.equal(context.refinements.length, 1); assert.equal(context.scopeCandidates.length, 1);
  assert.equal((await f.request(f.endpoint + '/business', { operation: 'refine', expectedRevision: snapshot.revision, idempotencyKey: 'stale', stationId: f.station.id, conditionIds: ['k1'], title: '过期', goal: '过期', changesContract: false })).status, 409);
  const view = await f.ok(f.endpoint + '/monitor');
  const output = await f.ok(f.endpoint + '/outputs', { stationId: f.station.id });
  assert.equal(output.resumeContext.basisRevision, view.revision);
  await f.command('scopeCandidate', { stationId: f.station.id, title: '另一候选', reason: '用于验证旧建议失效' });
  assert.equal((await f.request(f.endpoint + '/outputs', { stationId: f.station.id, expectedFingerprint: output.fingerprint })).status, 409);
  const model = await f.ok(f.endpoint + '/model'), changed = structuredClone(model); changed.model.requirements[0].stationIds = [];
  assert.equal((await f.request(f.endpoint + '/model', changed, 'PUT')).status, 400);
  const other = model.model.stations[1], binding = (await f.command('bind', { taskId: f.task.id, stationId: other.id, sourceId: f.bindings[1].sourceId, provider: 'fixture', hostId: 'fixture-host', dataRootId: 'fixture-root', sessionId: 'chat2', threadId: null, confirmationRef: '固定并行样例', workContext })).binding;
  const current = await f.ok(f.endpoint + '/model');
  assert.equal((await f.request(f.endpoint + '/business', { operation: 'claim', expectedRevision: current.revision, idempotencyKey: 'conflict-claim', scope: { ...f.scope(binding), stationId: other.id }, workContext, allowedPaths: [], reason: '同树冲突' })).status, 400);
  await f.evidence('K03-scope-ownership');
});

test('U03-K04 prepared、commit marker、安装快照故障均可恢复且无半项目', async t => {
  for (const point of ['beforePrepare', 'prepared', 'committed', 'installed']) await t.test(point, async t => {
    let armed = false;
    const f = await fixture(t, { storageFault: async phase => { if (armed && phase === point) { armed = false; throw Error(`Injected disk failure ${point}`); } } });
    const draft = await f.ok('/import-drafts', draftInput());
    const confirmation = await f.ok(`/import-drafts/${draft.draftId}/confirm`, { revision: 1, expectedRevision: 0, acknowledged: true });
    const body = { confirmationGrantId: confirmation.confirmationGrantId, confirmationDigest: confirmation.confirmationDigest, sourceHash: draft.source.sourceHash, idempotencyKey: 'fault-publish' };
    armed = true; assert.equal((await f.request(`/import-drafts/${draft.draftId}/publish`, body)).status, 500);
    const visible = await f.request('/projects');
    if (['committed', 'installed'].includes(point)) assert.equal(visible.status, 503); else { assert.equal(visible.status, 200); assert.equal(visible.value.projects.length, 0); }
    for (const suffix of ['', '/model', '/monitor', '/outputs']) {
      const result = await f.request(`/projects/${draft.projectId}${suffix}`, suffix === '/outputs' ? {} : undefined);
      assert.equal(result.status, ['committed', 'installed'].includes(point) ? 503 : 404);
    }
    await f.stop(); await f.start();
    const publication = await f.ok(`/import-drafts/${draft.draftId}/publish`, body);
    assert.equal((await f.ok('/projects')).projects.length, 1);
    assert.equal((await f.ok(`/projects/${publication.projectId}/model`)).model.stations.length, 8);
    const request = await f.ok('/requests', { projectId: draft.draftId, operation: 'draft.publish', idempotencyKey: body.idempotencyKey }); assert.equal(request.state, 'committed');
    await f.evidence('K04-fault-' + point);
  });
});

test('U03-K04 真实文件写入失败、旧数据迁移、全目录备份恢复', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'u03-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'legacy'), projects = await createStore(source);
  const project = await projects.create({ name: '旧样例', source: '原始文档', goal: '原始目标', steps: [] });
  const models = await createModelStore(path.join(source, 'models'), projects);
  let old = await models.get(project.id); old.model.receiptLog = { receipts: [], reviews: [], invalidations: [], events: [] };
  old = await models.update(project.id, old);
  const original = await readFile(path.join(source, 'projects.json'));
  const server = await createServer({ dataDir: source, env: {} }); server.emit('close');
  assert.deepEqual(await readFile(path.join(source, 'projects.json')), original);
  const aggregate = JSON.parse(await readFile(path.join(source, 'aggregate.json'), 'utf8'));
  assert.deepEqual(aggregate.models[project.id], old);
  const target = path.join(root, 'migrated'); await migrate(source, target);
  const restored = await createServer({ dataDir: target, env: {} });
  assert.equal(restored.workbench.store.get(project.id).name, '旧样例'); assert.deepEqual(await restored.workbench.models.get(project.id), old); restored.emit('close');
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'transaction.prepared.json'));
  assert.equal((await f.request('/projects', { name: '磁盘失败项目' })).status, 500);
  assert.equal((await f.ok('/projects')).projects.length, 0);
  await rm(path.join(f.root, 'transaction.prepared.json'), { recursive: true });
  const { publication } = await f.publish();
  await f.stop(); const backup = path.join(root, 'backup'); await cp(f.root, backup, { recursive: true });
  const recovered = await createServer({ dataDir: backup, env: {} });
  assert.equal((await recovered.workbench.models.get(publication.projectId)).model.stations.length, 8); recovered.emit('close');
  await assert.rejects(readFile(path.join(f.root, 'projects.json')), { code: 'ENOENT' });
  const aggregateTarget = path.join(root, 'aggregate-only-migrated');
  await migrate(f.root, aggregateTarget);
  const aggregateRestored = await createServer({ dataDir: aggregateTarget, env: {} });
  assert.equal((await aggregateRestored.workbench.models.get(publication.projectId)).model.stations.length, 8); aggregateRestored.emit('close');
  await f.evidence('K04-migration-disk-backup');
});

test('U03-K04 真实子进程在持久化各阶段退出，重开回查同一发布', async t => {
  for (const point of ['prepared', 'committed', 'installed']) await t.test(point, async t => {
    const f = await fixture(t);
    const draft = await f.ok('/import-drafts', draftInput());
    const confirmation = await f.ok(`/import-drafts/${draft.draftId}/confirm`, { revision: 1, expectedRevision: 0, acknowledged: true });
    const body = { confirmationGrantId: confirmation.confirmationGrantId, confirmationDigest: confirmation.confirmationDigest, sourceHash: draft.source.sourceHash, idempotencyKey: 'crash-publish' };
    const inputFile = path.join(f.root, 'crash-input.json'); await writeFile(inputFile, JSON.stringify({ draftId: draft.draftId, body }));
    await f.stop();
    const child = spawn(process.execPath, [fileURLToPath(new URL('../tests/helpers/u03-crash-worker.mjs', import.meta.url)), f.root, point, inputFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = ''; child.stderr.on('data', data => { diagnostics += data; });
    const [code] = await once(child, 'exit'); assert.equal(code, 77, diagnostics);
    await f.start();
    const request = await f.ok('/requests', { projectId: draft.draftId, operation: 'draft.publish', idempotencyKey: body.idempotencyKey });
    assert.equal(request.state, point === 'prepared' ? 'unknown' : 'committed');
    const publication = await f.ok(`/import-drafts/${draft.draftId}/publish`, body);
    assert.equal((await f.ok('/projects')).projects.length, 1);
    assert.equal((await f.ok(`/projects/${publication.projectId}/model`)).model.stations.length, 8);
    await f.evidence('K04-process-crash-' + point);
  });
});

test('U03-K03 原需求遗漏时全部站点通过仍不能关闭项目', () => {
  let m = legacyFixture(); m = complete(m, 'A'); m = complete(m, 'B', true);
  m.schemaVersion = '1.0.0'; m.requirements = [];
  m.initialRequirements = [{ requirementId: 'missing-original', originalText: '原始遗漏需求', stationIds: [], conditionIds: [] }];
  m = reconcileLifecycle(legacyProject.id, m);
  const view = inspectMonitor(legacyProject.id, m);
  assert.ok(view.stations.every(s => s.state === 'done')); assert.equal(view.project.eligible, false); assert.notEqual(view.project.status, 'closed');
});

test('U03-K01 追加方案版本保护初始目标，旧确认和旧绑定失效', async t => {
  const f = await executionFixture(t), old = await f.ok(f.endpoint + '/model');
  const input = draftInput(); input.targetProjectId = f.projectId; input.idempotencyKey = 'version-two'; input.candidate.previousPlanId = old.model.currentPlanId; input.candidate.version = '2.0';
  const remap = Object.fromEntries(['folder', 'task', ...Array.from({ length: 8 }, (_, i) => `s${i + 1}`), 'optional'].map(key => [key, key === 'folder' ? old.model.folders[0].id : key === 'task' ? old.model.tasks[0].id : key === 'optional' ? old.model.candidates[0].id : old.model.stations[Number(key.slice(1)) - 1].id]));
  input.candidate.folders[0].folderId = remap.folder;
  input.candidate.tasks[0].taskId = remap.task; input.candidate.tasks[0].folderId = remap.folder;
  input.candidate.stations.forEach(s => { s.stationId = remap[s.stationId]; s.taskId = remap.task; });
  input.candidate.candidates[0].candidateId = remap.optional;
  input.candidate.requirements.forEach(r => { r.stationIds = r.stationIds.map(id => remap[id]); });
  input.candidate.goal = '当前目标经过明确差异确认';
  input.candidate.provenance = input.candidate.provenance.map(p => p.fieldPath === '/goal' || p.fieldPath === '/version' ? { ...p, origin: 'user', locator: '固定用户修订', excerpt: null, startUtf16: null, endUtf16: null } : p);
  const overwrite = structuredClone(input); overwrite.idempotencyKey = 'protected-task-goal'; overwrite.candidate.tasks[0].initialGoal = '覆盖原任务目标';
  const rejectedDraft = await f.ok('/import-drafts', overwrite); assert.equal(rejectedDraft.status, 'needs-review'); assert.ok(rejectedDraft.issues.some(i => i.message.includes('原始任务目标不可覆盖')));
  const { publication } = await f.publish(input);
  const current = await f.ok(f.endpoint + '/model');
  assert.equal(current.model.initialPlanId, old.model.initialPlanId); assert.equal(current.model.plans.length, 2); assert.equal(current.model.plans[0].source, old.model.plans[0].source);
  assert.equal(current.model.currentPlanId, publication.planId); assert.equal(current.model.stations[0].id, old.model.stations[0].id);
  assert.equal(current.model.business.executions.length, 1); assert.equal((await f.ok(f.endpoint + '/monitor')).stations[0].ready, false);
  assert.equal((await f.request(f.endpoint + '/business', { operation: 'claim', expectedRevision: current.revision, idempotencyKey: 'old-binding', scope: f.scope(f.bindings[0]), workContext, allowedPaths: [], reason: '旧绑定负例' })).status, 409);
  await f.evidence('K01-plan-version');
});

test('U03-K01 初始与当前项目目标分别保留，结束条件进入必需验收', async t => {
  const f = await fixture(t), input = draftInput();
  input.candidate.initialGoal = '用户确认的初始目标';
  input.candidate.provenance = input.candidate.provenance.map(p => p.fieldPath === '/initialGoal' ? { ...p, origin: 'user', locator: '固定用户确认的初始目标', excerpt: null, startUtf16: null, endUtf16: null } : p);
  const { publication } = await f.publish(input), model = await f.ok(`/projects/${publication.projectId}/model`), view = await f.ok(`/projects/${publication.projectId}/monitor`);
  assert.equal(view.project.originalGoal, '用户确认的初始目标'); assert.equal(view.project.currentGoal, '完成固定业务路线');
  assert.ok(model.model.acceptance.includes(input.candidate.endCondition)); assert.ok(model.model.tasks[0].acceptance.includes(input.candidate.tasks[0].endCondition));
  await f.evidence('K01-original-goal-endpoint');
});

test('U03-K04 发布响应真实丢失后，查询原键并发重放返回原结果', async t => {
  let drop = false;
  const f = await fixture(t, { afterCommit: async req => { if (drop && req.url.endsWith('/publish')) { drop = false; return 'drop'; } } });
  const draft = await f.ok('/import-drafts', draftInput());
  const confirmation = await f.ok(`/import-drafts/${draft.draftId}/confirm`, { revision: 1, expectedRevision: 0, acknowledged: true });
  const body = { confirmationGrantId: confirmation.confirmationGrantId, confirmationDigest: confirmation.confirmationDigest, sourceHash: draft.source.sourceHash, idempotencyKey: 'lost-response' };
  drop = true; await assert.rejects(f.request(`/import-drafts/${draft.draftId}/publish`, body), /fetch failed/);
  const query = await f.ok('/requests', { projectId: draft.draftId, operation: 'draft.publish', idempotencyKey: body.idempotencyKey });
  assert.equal(query.state, 'committed');
  const replayed = await Promise.all(Array.from({ length: 5 }, () => f.ok(`/import-drafts/${draft.draftId}/publish`, body)));
  assert.ok(replayed.every(p => p.requestId === query.requestId && p.publicationId === query.result.publicationId));
  assert.equal((await f.ok('/projects')).projects.length, 1);
  await f.evidence('K04-lost-response');
});

test('U03-K02 同一修复请求重试只记一轮，并发版本只允许一笔写入', async t => {
  const f = await executionFixture(t);
  const base = { schemaVersion: '1.0.0', projectId: f.projectId, actorDeclaration, scope: f.scope(f.bindings[0], f.execution.executionId) };
  await f.command('receipt', { ...base, workContext, deliveryVersion: 'initial', actual: '首次失败', raw: '首次回执', checks: [], evidence: [], unresolved: ['未满足原条件'], endedAt: timestamp, outcome: 'failed', next: [] });
  const model = await f.ok(f.endpoint + '/model');
  const repair = await f.command('repair', { ...base, action: 'createCase', case: { triggerReceiptId: null, failedConditionIds: ['k1'], problem: '固定回归', expectedResult: '满足原条件', scopeClass: 'requiredRepair', closeConditions: ['k1'], returnAnchor: { projectId: f.projectId, taskId: f.task.id, stationId: f.station.id, planId: f.station.planId, conditionIds: ['k1'], dependencyStationIds: [], successorStationIds: [], mergeStationIds: [], basisRevision: model.revision } } });
  const current = await f.ok(f.endpoint + '/model');
  const body = { ...base, operation: 'repair', expectedRevision: current.revision, idempotencyKey: 'same-attempt', action: 'appendAttempt', repairId: repair.repairId, attempt: { goal: '同轮重试', method: '固定方法', workContext, startedAt: timestamp } };
  const results = await Promise.all(Array.from({ length: 5 }, () => f.ok(f.endpoint + '/business', body)));
  assert.equal(new Set(results.map(r => r.attemptId)).size, 1); assert.equal((await f.ok(f.endpoint + '/business')).repairRounds, 1);
  const after = await f.ok(f.endpoint + '/model');
  const writes = await Promise.all(Array.from({ length: 5 }, (_, i) => f.request(f.endpoint + '/business', { operation: 'scopeCandidate', expectedRevision: after.revision, idempotencyKey: `parallel-${i}`, stationId: f.station.id, title: '独立建议', reason: '固定并发输入' })));
  assert.equal(writes.filter(r => r.status === 200).length, 1); assert.equal(writes.filter(r => r.status === 409).length, 4);
  await f.evidence('K02-attempt-idempotency');
});
