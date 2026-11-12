// 日期：2026-11-12。隔离 Git、确定性宿主替身及真实协调日志；不访问任何业务项目。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCoordination, mapLine, planBatch, dispatchTask, verifyTarget, observeTask, recoveryReport,
  saveCheckpoint, withCheckpoint, stageDispatch, recordNativeResult, nativeAdapter, validateCoordination, createRequest, adoptCoordination, reconcileNotSubmitted }
  from '../../plugins/task-workbench/skills/workbench-handoff/scripts/coordination.mjs';

const inspection = (directory, branch = 'codex/service') => ({ worktreePath: directory, repositoryRoot: 'G:\\repo', gitCommonDir: 'G:\\repo\\.git', head: 'a'.repeat(40), branch });
const inspect = async (directory, branch) => inspection(directory, branch);
const projects = ['service', 'design', 'core', 'ui'].map((name, i) => ({ projectId: 'host-' + name, hostId: 'local', path: `G:\\trees\\${name}`, label: '同名项目' }));
const spec = { title: '隔离任务 / 服务实现', goal: '完成隔离任务', scope: '仅夹具', sharedFiles: '合同由集成负责', dependencies: '无额外前置',
  versions: 'contract-v1 / peer-v1', acceptance: '定向检查通过', stopConditions: '身份、许可未知时停止实施', receipt: '提交、检查、事件键与剩余事项' };
const task = (lineId = 'service', stepId = 's1') => ({ id: 'task-' + lineId, lineId, stepIds: [stepId], spec });
const authorization = () => ({ mode: 'execute', source: { threadId: 'human-chat', locator: 'human-turn-1', quote: '在隔离项目创建聊天、派发并跟踪，按依赖接续' },
  permissions: ['createChat', 'dispatch', 'collect', 'continue'], lineIds: ['service', 'design', 'core', 'ui'], stepIds: ['s1', 's2', 's3', 's4'] });
const stateOf = (auth = authorization()) => createCoordination({ id: 'isolated-coordination', projectId: 'p', planId: 'plan', coordinator: { threadId: 'coordinator', hostId: 'local' }, authorization: auth });
function snapshotOf() {
  return { projects: [{ id: 'p', key: 'pk' }], plans: [{ id: 'plan', key: 'pl', projectKey: 'pk' }], bindings: [], executions: [],
    steps: ['s1', 's2', 's3', 's4'].map((id, i) => ({ id, key: 'key-' + id, planKey: 'pl', projectKey: 'pk', parentKey: null,
      status: 'pending', acceptance: 'pending', sync: 'synced', conditions: [], evidence: [], blockers: [], dependsOn: i === 1 ? ['key-s1'] : [] })) };
}
async function mapped(state, lineId = 'service', stepId = 's1', worktreePath = `G:\\trees\\${lineId}`) {
  return mapLine(state, { lineId, hostId: 'local', hostProjectId: 'host-' + lineId, worktreePath, branch: 'codex/' + lineId, stepIds: [stepId] }, projects, inspect);
}
async function prepared() {
  const state = stateOf(), snapshot = snapshotOf(); await mapped(state); planBatch(state, { id: 'batch1', tasks: [task()] }, snapshot);
  return { state, snapshot, checkpoint: async () => {}, projects, inspect };
}
async function created(options) {
  const adapter = { createChat: async op => ({ targetId: 'thread-1', hostId: 'local', request: op.request }) };
  await dispatchTask(options.state, 'batch1', 'task-service', { ...options, adapter });
  await verifyTarget(options.state, 'batch1', 'task-service', { threadId: 'thread-1', hostId: 'local', hostProjectId: 'host-service',
    worktreePath: 'G:\\trees\\service', branch: 'codex/service', evidence: 'native context + actual Git' }, inspect);
}
test('仅核对/生成不保存批次或调用宿主，执行授权不能从生成请求推断', async () => {
  for (const mode of ['inspect', 'generate']) {
    const state = stateOf({ ...authorization(), mode }); await mapped(state); const before = structuredClone(state);
    const result = planBatch(state, { id: 'batch1', tasks: [task()] }, snapshotOf());
    assert.equal(result.tasks.length, 0); assert.deepEqual(state, before);
    await assert.rejects(dispatchTask(state, 'batch1', 'task-service', {}), /TASK_NOT_FOUND/);
  }
});
test('本批仅服务线需要且依赖满足，其他三线不随四项目存在而启动', async () => {
  const state = stateOf(), snapshot = snapshotOf();
  for (const [i, line] of ['service', 'design', 'core', 'ui'].entries()) await mapped(state, line, 's' + (i + 1));
  const batch = planBatch(state, { id: 'batch1', tasks: [task(), task('design', 's2')] }, snapshot);
  assert.deepEqual(batch.tasks.map(item => item.lineId), ['service']);
  assert.match(batch.deferred[0].reasons.join(','), /DEPENDENCY/);
  assert.equal(state.operations.length, 0);
});
test('正确项目 local 请求与错误已有工作树能力门禁分别验证', async () => {
  const options = await prepared(); let calls = 0;
  const adapter = { createChat: async op => { calls++; assert.equal(op.request.target.projectId, 'host-service');
    assert.deepEqual(op.request.target.environment, { type: 'local' }); return { targetId: 'thread-1', hostId: 'local' }; } };
  await dispatchTask(options.state, 'batch1', 'task-service', { ...options, adapter }); assert.equal(calls, 1);
  assert.equal(options.state.batches[0].tasks[0].state, 'created');
  const mismatch = await prepared();
  await assert.rejects(dispatchTask(mismatch.state, 'batch1', 'task-service', { ...mismatch, adapter,
    projects: [{ ...projects[0], path: 'G:\\source' }] }), /HOST_EXISTING_WORKTREE_UNSUPPORTED/);
  assert.equal(calls, 1); assert.equal(mismatch.state.operations.length, 0);
  assert.throws(() => createRequest(options.state, task(), options.state.mappings[0].mapping, []), /HOST_PROJECT_NOT_FOUND/);
});
test('同源目录不同工作树允许独立任务，共享同一目录及合同/缓存写入串行', async () => {
  const sameSource = projects.map(item => ({ ...item, path: 'G:\\source' }));
  const state = stateOf();
  for (const [i, line] of ['service', 'core'].entries()) await mapLine(state, { lineId: line, hostId: 'local', hostProjectId: 'host-' + line,
    stepIds: [i ? 's3' : 's1'], worktreePath: `G:\\trees\\${line}`, branch: 'codex/' + line }, sameSource, inspect);
  assert.equal(planBatch(state, { id: 'b1', tasks: [task(), task('core', 's3')] }, snapshotOf()).tasks.length, 2);
  const shared = stateOf(); await mapped(shared); await mapped(shared, 'core', 's3', 'g:/trees/SERVICE/');
  const batch = planBatch(shared, { id: 'b1', tasks: [task(), task('core', 's3')] }, snapshotOf());
  assert.equal(batch.tasks.length, 1); assert.ok(batch.deferred[0].reasons.includes('SHARED_WORKTREE'));
  const resources = stateOf(); await mapped(resources); await mapped(resources, 'core', 's3');
  const resource = [{ key: 'shared-build-cache', mode: 'write' }];
  assert.equal(planBatch(resources, { id: 'b1', tasks: [{ ...task(), resources: resource }, { ...task('core', 's3'), resources: resource }] }, snapshotOf()).tasks.length, 1);
});
test('真实 Git 公共仓库与两个工作树分别识别，独立仓库没有误合并', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'coord-git-'));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); });
  const git = args => execFileSync('git', args, { windowsHide: true, stdio: 'pipe' });
  const repo = path.join(root, 'repo'), second = path.join(root, 'second');
  git(['init', '-b', 'main', repo]); git(['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
  git(['-C', repo, 'worktree', 'add', '-b', 'codex/second', second, 'HEAD']);
  const state = stateOf(), hostProjects = [{ ...projects[0], path: repo }, { ...projects[2], path: repo }];
  const first = await mapLine(state, { lineId: 'service', hostId: 'local', hostProjectId: 'host-service', stepIds: ['s1'], worktreePath: repo, branch: 'main' }, hostProjects);
  const next = await mapLine(state, { lineId: 'core', hostId: 'local', hostProjectId: 'host-core', stepIds: ['s3'], worktreePath: second, branch: 'codex/second' }, hostProjects);
  assert.equal(first.repositoryRoot, next.repositoryRoot); assert.equal(first.gitCommonDir, next.gitCommonDir); assert.notEqual(first.worktreePath, next.worktreePath);
  assert.equal(planBatch(state, { id: 'b1', tasks: [task(), task('core', 's3')] }, snapshotOf()).tasks.length, 2);
  const independent = path.join(root, 'independent'); git(['init', '-b', 'codex/ui', independent]);
  git(['-C', independent, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
  const ui = await mapLine(state, { lineId: 'ui', hostId: 'local', hostProjectId: 'host-ui', stepIds: ['s4'], worktreePath: independent, branch: 'codex/ui' }, [...hostProjects, { ...projects[3], path: repo }]);
  assert.notEqual(ui.repositoryRoot, first.repositoryRoot); assert.notEqual(ui.gitCommonDir, first.gitCommonDir);
});
test('创建与派发各一次，上下文错配拦截，重复请求复用原操作', async () => {
  const options = await prepared(); let creates = 0, sends = 0;
  const adapter = { createChat: async () => ({ targetId: 'thread-' + (++creates), hostId: 'local' }),
    sendMessage: async op => { sends++; assert.equal(op.request.threadId, 'thread-1'); assert.match(op.request.prompt, /contract-v1/); return { targetId: 'thread-1' }; } };
  await dispatchTask(options.state, 'batch1', 'task-service', { ...options, adapter });
  await assert.rejects(dispatchTask(options.state, 'batch1', 'task-service', { ...options, adapter }), /IDENTITY_UNCONFIRMED/);
  await assert.rejects(verifyTarget(options.state, 'batch1', 'task-service', { threadId: 'thread-1', hostId: 'local', hostProjectId: 'host-core', evidence: 'x' }, inspect), /IDENTITY_UNCONFIRMED/);
  await verifyTarget(options.state, 'batch1', 'task-service', { threadId: 'thread-1', hostId: 'local', hostProjectId: 'host-service', worktreePath: 'G:\\trees\\service', branch: 'codex/service', evidence: 'native verified' }, inspect);
  await dispatchTask(options.state, 'batch1', 'task-service', { ...options, adapter });
  await dispatchTask(options.state, 'batch1', 'task-service', { ...options, adapter });
  assert.equal(creates, 1); assert.equal(sends, 1); assert.equal(options.state.batches[0].tasks[0].state, 'delivered');
});
test('创建后派发失败保留聊天，未知响应和中断从磁盘恢复且不重复创建', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'coord-checkpoint-')); const file = path.join(root, 'state.json');
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); });
  const options = await prepared(); let calls = 0;
  const checkpoint = state => saveCheckpoint(file, state);
  const adapter = { createChat: async () => { calls++; const disk = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(disk.operations[0].status, 'pending'); throw Object.assign(Error('RESPONSE_LOST'), { resultUnknown: true }); } };
  await dispatchTask(options.state, 'batch1', 'task-service', { ...options, adapter, checkpoint });
  const recovered = JSON.parse(await readFile(file, 'utf8'));
  await dispatchTask(recovered, 'batch1', 'task-service', { ...options, adapter, checkpoint }); assert.equal(calls, 1);
  assert.equal(recoveryReport(recovered).unknownOperations.length, 1);
  adapter.reconcile = async () => ({ state: 'succeeded', targetId: 'thread-existing', result: { hostId: 'local' } });
  await dispatchTask(recovered, 'batch1', 'task-service', { ...options, adapter, checkpoint });
  assert.equal(recovered.batches[0].tasks[0].threadId, 'thread-existing'); assert.equal(calls, 1);
  await assert.rejects(withCheckpoint(file, async () => withCheckpoint(file, async () => {})), /EEXIST/);
});
test('两段原生调用先落盘，record 保存实际结果，空/错误回执不声称送达', async () => {
  const options = await prepared(); const first = await stageDispatch(options.state, 'batch1', 'task-service', options);
  assert.equal(first.nativeCall.name, 'create_thread');
  const again = await stageDispatch(options.state, 'batch1', 'task-service', options); assert.equal(again.nativeCall, null);
  const result = { content: [{ type: 'text', text: JSON.stringify({ threadId: 'thread-created', hostId: 'local' }) }] };
  await recordNativeResult(options.state, { operationId: first.nativeCall.operationId, result, evidence: 'actual tool response' }, options.checkpoint);
  await stageDispatch(options.state, 'batch1', 'task-service', options);
  assert.equal(options.state.batches[0].tasks[0].threadId, 'thread-created');
  const adapter = nativeAdapter(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  await assert.rejects(adapter.sendMessage({ request: { threadId: 'x' } }), error => error.resultUnknown === true);
});
test('原执行沿用，缺绑定/开始证据时不会由聊天创建或最终文本冒充完成', async () => {
  const options = await prepared(); const snapshot = options.snapshot;
  snapshot.bindings.push({ key: 'b', id: 'binding-id', bindingRevision: 2, state: 'confirmed', revokedAt: null, stepKeys: ['key-s1'],
    context: { threadId: 'old-thread', hostId: 'local', folderId: 'host-service', worktreePath: 'G:\\trees\\service', branch: 'codex/service' } });
  snapshot.executions.push({ id: 'same-execution', key: 'e', bindingKey: 'b', stepKeys: ['key-s1'], startedAt: '2026-11-12T01:00:00Z', endedAt: null });
  Object.assign(snapshot.steps[0], { status: 'running', bindingKey: 'b', executionKey: 'e' });
  await assert.rejects(dispatchTask(options.state, 'batch1', 'task-service', { ...options, adapter: { createChat: async () => { throw Error('must not create'); } } }), /IDENTITY_UNCONFIRMED/);
  assert.deepEqual(options.state.batches[0].tasks[0].executionIds, ['same-execution']);
  const first = observeTask(options.state, 'batch1', 'task-service', { snapshot, evidence: 'service read' }); assert.equal(first.status, 'started');
  assert.equal(observeTask(options.state, 'batch1', 'task-service', { snapshot, evidence: 'service read' }).changed, false);
  const receipt = { threadId: 'old-thread', hostId: 'local', projectId: 'p', planId: 'plan', stepIds: ['s1'], executionIds: ['same-execution'], evidenceVerified: true, evidence: 'commit inspected', handoff: 'E' };
  assert.equal(observeTask(options.state, 'batch1', 'task-service', { snapshot, receipt, evidence: 'service read' }).status, 'started');
  Object.assign(snapshot.steps[0], { status: 'completed', acceptance: 'passed' }); snapshot.executions[0].endedAt = '2026-11-12T02:00:00Z';
  assert.equal(observeTask(options.state, 'batch1', 'task-service', { snapshot, receipt: { ...receipt, threadId: 'wrong' }, evidence: 'service read' }).status, 'receiptReview');
  assert.equal(observeTask(options.state, 'batch1', 'task-service', { snapshot, receipt, evidence: 'service + commit verified' }).status, 'verified');
  assert.equal(recoveryReport(options.state).unfinished.length, 0);
  assert.equal(snapshot.steps[1].status, 'pending', '单线完成不代表项目完成');
});
test('缺少登记集中返回恢复项；授权范围、成功操作历史及批次意图不可偷偷改写', async () => {
  const state = stateOf(); await mapped(state);
  const batch = planBatch(state, { id: 'b1', tasks: [task()] }, { projects: [], plans: [] });
  assert.ok(batch.deferred[0].reasons.includes('SERVICE_REGISTRATION_REQUIRED'));
  assert.equal(recoveryReport(state).deferred.length, 1);
  assert.throws(() => planBatch(state, { id: 'b1', tasks: [{ ...task(), id: 'changed' }] }, snapshotOf()), /IDEMPOTENCY_CONFLICT/);
  const options = await prepared(); await created(options); const old = structuredClone(options.state);
  options.state.operations = []; assert.throws(() => validateCoordination(options.state, old), /HISTORY_REQUIRED/);
});
test('协调接手保留原任务和未确认事件，回报权限不自动扩展到新聊天', async () => {
  const options = await prepared(); options.state.authorization.permissions.push('reportBack');
  const before = structuredClone(options.state);
  adoptCoordination(options.state, { coordinator: { threadId: 'next-coordinator', hostId: 'local' }, evidence: '旧协调已停止；从原人类授权与同一检查点接手' });
  assert.equal(validateCoordination(options.state, before), options.state);
  assert.equal(options.state.authorization.permissions.includes('reportBack'), false);
  assert.equal(options.state.batches[0].tasks[0].id, 'task-service');
  options.state.unconfirmedEvents.push({ eventId: 'old-start', stepIds: ['s1'] });
  await assert.rejects(dispatchTask(options.state, 'batch1', 'task-service', options), /UNCONFIRMED_EVENT_REQUIRES_QUERY/);
});
test('未知发送不重发，明确未提交的证据恢复后复用原键，成功部分不能抹除', async () => {
  const options = await prepared(); await created(options);
  const staged = await stageDispatch(options.state, 'batch1', 'task-service', options);
  assert.equal(staged.nativeCall.name, 'send_message_to_thread');
  assert.equal((await stageDispatch(options.state, 'batch1', 'task-service', options)).nativeCall, null);
  await assert.rejects(reconcileNotSubmitted(options.state, { operationId: staged.nativeCall.operationId, proof: 'notFoundInList', evidence: '未找到' }, options.checkpoint), /NON_SUBMISSION_PROOF/);
  await reconcileNotSubmitted(options.state, { operationId: staged.nativeCall.operationId, proof: 'nativeRequestNotInvoked', evidence: '准备后尚未调用原生工具的可核实中断位置' }, options.checkpoint);
  const retried = await stageDispatch(options.state, 'batch1', 'task-service', options);
  assert.equal(retried.nativeCall.operationId, staged.nativeCall.operationId);
  assert.equal(options.state.operations.filter(item => item.intent.kind === 'createChat').length, 1);
});
test('依赖解除后任务进入后续批次，恢复清单不再把旧缺项报告为当前阻塞', async () => {
  const state = stateOf(), snapshot = snapshotOf(); await mapped(state, 'design', 's2');
  planBatch(state, { id: 'waiting', tasks: [task('design', 's2')] }, snapshot);
  assert.equal(recoveryReport(state).deferred.length, 1);
  Object.assign(snapshot.steps[0], { status: 'completed', acceptance: 'passed' });
  planBatch(state, { id: 'successor', tasks: [task('design', 's2')] }, snapshot);
  assert.equal(recoveryReport(state).deferred.length, 0);
  assert.equal(state.batches[0].deferred.length, 1, '原批次历史继续保留');
});
