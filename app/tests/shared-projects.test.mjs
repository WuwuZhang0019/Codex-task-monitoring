// 日期：2026-11-13。已有来源目录复用、具名项目归类与原生独立工作树的真实 Git 回归。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCoordination, sharedSourceTargets, prepareHostProject, mapLine, validateCoordination,
  createRequest, planBatch, dispatchTask, verifyTarget, verifyHostProject, recoveryReport,
  stageDispatch, recordNativeResult, recordWorkspaceWait } from '../../plugins/task-workbench/skills/workbench-handoff/scripts/coordination.mjs';
import { inspectWorkspace } from '../../plugins/task-workbench/skills/workbench-handoff/scripts/context-ledger.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shared-source-'));
  let repo = path.join(root, 'source');
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); });
  const git = (...args) => execFileSync('git', args, { windowsHide: true, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main', repo);
  repo = await realpath(repo);
  git('-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
  for (const name of ['ab', 'cd']) git('-C', repo, 'branch', 'codex/' + name);
  const projects = [{ projectId: 'existing-source', hostId: 'local', path: repo, label: '已有项目', isGitRepository: true }];
  const lines = ['ab', 'cd'].map((lineId, i) => ({ lineId, stepIds: ['s' + (i + 1)], execution: { type: 'managed-worktree', startingRef: 'codex/' + lineId } }));
  const targets = sharedSourceTargets({ sourceHostProjectId: projects[0].projectId, projects, lines });
  const state = createCoordination({ id: 'shared-source-test', projectId: 'project', planId: 'plan', coordinator: { threadId: 'coordinator', hostId: 'local' },
    authorization: { mode: 'execute', source: { threadId: 'human', locator: 'turn', quote: '复用来源目录，各分支用独立工作树执行' },
      permissions: ['createChat', 'createWorktree', 'dispatch', 'collect', 'continue'], lineIds: ['ab', 'cd'], stepIds: ['s1', 's2'] } });
  const snapshot = { projects: [{ id: 'project', key: 'p' }], plans: [{ id: 'plan', key: 'pl', projectKey: 'p' }], bindings: [], executions: [],
    steps: ['s1', 's2'].map(id => ({ id, key: id, projectKey: 'p', planKey: 'pl', dependsOn: [], status: 'pending', acceptance: 'pending', conditions: [], blockers: [], evidence: [] })) };
  const spec = { title: '隔离核验', goal: '读取上下文', scope: '仅夹具', sharedFiles: '无', dependencies: '无', versions: 'v1', acceptance: '真实上下文', stopConditions: '信任或身份未确认停止', receipt: '目录、提交及证据' };
  const tasks = targets.map(target => ({ id: 'task-' + target.lineId, lineId: target.lineId, stepIds: target.stepIds, spec }));
  const checkpoint = async () => {};
  const mapped = async () => { for (const target of targets) await mapLine(state, { ...target, hostProjectId: 'existing-source' }, projects); planBatch(state, { id: 'batch', tasks }, snapshot); };
  return { root, repo, git, projects, lines, targets, state, snapshot, tasks, checkpoint, mapped };
}

test('来源项目统一复用，执行路径留空；准备不会创建项目、打开目录或切来源分支', async t => {
  const f = await fixture(t);
  for (const target of f.targets) {
    assert.equal(target.projectSourcePath, f.repo); assert.equal(target.worktreePath, null);
    const result = await prepareHostProject(f.state, { target, projects: f.projects }, f.checkpoint, {
      client: { list() { throw Error('must not create'); }, close() {} }, openWorkspace() { throw Error('must not open'); },
    });
    assert.equal(result.status, 'ready'); assert.equal(result.hostProjectId, 'existing-source');
    assert.equal(result.projectSourcePath, f.repo); assert.equal(result.worktreePath, null);
  }
  assert.equal(f.state.operations.length, 0);
  assert.equal(f.git('-C', f.repo, 'branch', '--show-current'), 'main');
  assert.throws(() => sharedSourceTargets({ sourceHostProjectId: 'missing', projects: f.projects, lines: f.lines }), /SOURCE_GIT_PROJECT/);
});

test('需要单独项目归类时仍选同一来源目录，并按名称加路径核验而不误用现有同路径项目', async t => {
  const f = await fixture(t), target = sharedSourceTargets({ sourceHostProjectId: 'existing-source', projects: f.projects,
    lines: [{ ...f.lines[0], separateProject: true, label: '分支一' }] })[0];
  const native = { id: 'public-line-id', name: '分支一', roots: [{ path: f.repo }] };
  let opened;
  const result = await prepareHostProject(f.state, { target, projects: f.projects }, f.checkpoint, { openWorkspace: async directory => { opened = directory; }, client: {
    list: async () => ({ data: [{ ...native, id: 'public-source', name: '已有项目' }] }),
    create: async request => { assert.equal(request.name, '分支一'); assert.deepEqual(request.roots, [{ path: f.repo }]); return { project: native }; },
    read: async () => ({ project: native }), close() {},
  } });
  assert.equal(opened, f.repo); assert.equal(result.worktreePath, null); assert.equal(result.operation.status, 'pending');
  await assert.rejects(verifyHostProject(f.state, { operationId: result.operation.operationId, projects: f.projects, evidence: 'same source only' }, f.checkpoint), /NOT_CONFIRMED/);
  const verified = await verifyHostProject(f.state, { operationId: result.operation.operationId,
    projects: [...f.projects, { ...f.projects[0], label: '分支一', projectId: 'host-line-id' }], evidence: 'actual host projection' }, f.checkpoint);
  assert.equal(verified.targetId, 'host-line-id');
});

test('同一来源两线可规划原生工作树，实际路径未知时不误判共享目录；未授权工作树不能创建', async t => {
  const f = await fixture(t); await f.mapped();
  assert.equal(f.state.batches[0].tasks.length, 2); assert.equal(validateCoordination(f.state), f.state);
  const mapping = f.state.mappings[0].mapping;
  assert.equal(mapping.worktreePath, null); assert.equal(mapping.head, null); assert.equal(mapping.branch, null);
  const request = createRequest(f.state, f.tasks[0], mapping, f.projects);
  assert.equal(request.target.projectId, 'existing-source');
  assert.deepEqual(request.target.environment, { type: 'worktree', startingState: { type: 'branch', branchName: 'codex/ab' } });
  assert.equal(Object.hasOwn(request.target.environment, 'path'), false);
  f.state.authorization.permissions = f.state.authorization.permissions.filter(p => p !== 'createWorktree');
  assert.throws(() => createRequest(f.state, f.tasks[0], mapping, f.projects), /CREATE_WORKTREE_AUTHORIZATION/);
});

test('信任等待保留原聊天且不派发；真实独立 detached 工作树核验后才放行', async t => {
  const f = await fixture(t); await f.mapped(); let creates = 0, sends = 0;
  const options = { ...f, adapter: { createChat: async () => ({ targetId: 'native-thread-' + (++creates), hostId: 'local' }),
    sendMessage: async () => { sends++; return { targetId: 'native-thread-1' }; } } };
  await dispatchTask(f.state, 'batch', 'task-ab', options);
  const identity = { threadId: 'native-thread-1', hostId: 'local', hostProjectId: 'existing-source', evidence: 'native host observation' };
  const waiting = await verifyTarget(f.state, 'batch', 'task-ab', { ...identity, accessState: 'waitingForTrust' });
  assert.equal(waiting.reason, 'WORKSPACE_TRUST_REQUIRED');
  assert.equal((await dispatchTask(f.state, 'batch', 'task-ab', options)).next, 'awaitFolderTrust');
  assert.equal(creates, 1); assert.equal(sends, 0);
  assert.equal(recoveryReport(f.state).unfinished[0].contextAccess.state, 'waitingForTrust');
  const worktree = path.join(f.root, 'native-tree');
  f.git('-C', f.repo, 'worktree', 'add', '--detach', worktree, 'codex/ab');
  const actual = await inspectWorkspace(worktree);
  assert.equal(actual.branch, null); assert.match(actual.head, /^[a-f0-9]{40}$/);
  await verifyTarget(f.state, 'batch', 'task-ab', { ...identity, accessState: 'ready', worktreePath: worktree, branch: null });
  await dispatchTask(f.state, 'batch', 'task-ab', options);
  assert.equal(sends, 1); assert.equal(creates, 1);
  assert.equal(f.state.mappings[0].mapping.worktreePath, actual.worktreePath);
  assert.equal(f.git('-C', f.repo, 'branch', '--show-current'), 'main');
});

test('来源目录、错误仓库、错误起始提交均不能冒充独立工作树', async t => {
  const f = await fixture(t); await f.mapped();
  await dispatchTask(f.state, 'batch', 'task-ab', { ...f, adapter: { createChat: async () => ({ targetId: 'thread', hostId: 'local' }) } });
  const identity = { threadId: 'thread', hostId: 'local', hostProjectId: 'existing-source', accessState: 'ready', evidence: 'actual context' };
  await assert.rejects(verifyTarget(f.state, 'batch', 'task-ab', { ...identity, worktreePath: f.repo, branch: 'main' }), /ISOLATION/);
  const clone = path.join(f.root, 'other-repository'); f.git('init', '-b', 'main', clone);
  f.git('-C', clone, '-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'independent');
  await assert.rejects(verifyTarget(f.state, 'batch', 'task-ab', { ...identity, worktreePath: clone, branch: 'main' }), /REPOSITORY_MISMATCH/);
  const tree = path.join(f.root, 'wrong-head'); f.git('-C', f.repo, 'worktree', 'add', '--detach', tree, 'codex/ab');
  f.git('-C', tree, '-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'other head');
  await assert.rejects(verifyTarget(f.state, 'batch', 'task-ab', { ...identity, worktreePath: tree, branch: null }), /STARTING_HEAD_MISMATCH/);
  assert.equal(f.state.batches[0].tasks[0].targetEvidence, undefined);
});

test('两个任务实际落入同一工作树会被拦截，来源相同不代替执行目录隔离', async t => {
  const f = await fixture(t); await f.mapped();
  for (const line of ['ab', 'cd']) await dispatchTask(f.state, 'batch', 'task-' + line, { ...f,
    adapter: { createChat: async () => ({ targetId: 'thread-' + line, hostId: 'local' }) } });
  const tree = path.join(f.root, 'shared-tree'); f.git('-C', f.repo, 'worktree', 'add', '--detach', tree, 'codex/ab');
  const observation = { hostId: 'local', hostProjectId: 'existing-source', accessState: 'ready', worktreePath: tree, branch: null, evidence: 'actual context' };
  await verifyTarget(f.state, 'batch', 'task-ab', { ...observation, threadId: 'thread-ab' });
  await assert.rejects(verifyTarget(f.state, 'batch', 'task-cd', { ...observation, threadId: 'thread-cd' }), /SHARED_WORKTREE/);
});

test('起点缺失或创建前发生变化时停止，不在来源目录自动建分支或切分支', async t => {
  const f = await fixture(t);
  await assert.rejects(mapLine(f.state, { ...f.targets[0], execution: { type: 'managed-worktree', startingRef: 'codex/missing' } }, f.projects));
  assert.equal(f.state.mappings.length, 0);
  await f.mapped();
  f.git('-C', f.repo, '-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'new source head');
  f.git('-C', f.repo, 'branch', '-f', 'codex/ab', 'HEAD');
  await assert.rejects(dispatchTask(f.state, 'batch', 'task-ab', { ...f, adapter: { createChat() { throw Error('must not create'); } } }), /STARTING_REF_CHANGED/);
  assert.equal(f.state.operations.length, 0); assert.equal(f.git('-C', f.repo, 'branch', '--show-current'), 'main');
});

test('原生工作树仅返回 clientThreadId 时记录信任等待，原结果就绪后续用而不重复创建', async t => {
  const f = await fixture(t); await f.mapped();
  const staged = await stageDispatch(f.state, 'batch', 'task-ab', f);
  assert.equal(staged.nativeCall.arguments.target.environment.type, 'worktree');
  await recordNativeResult(f.state, { operationId: staged.nativeCall.operationId,
    result: { clientThreadId: 'setup-pending' }, evidence: 'actual pending setup result' }, f.checkpoint);
  assert.throws(() => recordWorkspaceWait(f.state, { batchId: 'batch', taskId: 'task-ab', accessState: 'ready', evidence: 'cannot approve via recorder' }), /WAIT_EVIDENCE/);
  recordWorkspaceWait(f.state, { batchId: 'batch', taskId: 'task-ab', accessState: 'waitingForTrust', evidence: 'actual native trust request' });
  assert.equal((await stageDispatch(f.state, 'batch', 'task-ab', f)).nativeCall, null);
  assert.equal((await stageDispatch(f.state, 'batch', 'task-ab', f)).next, 'awaitFolderTrust');
  await recordNativeResult(f.state, { operationId: staged.nativeCall.operationId,
    result: { threadId: 'real-thread', hostId: 'local' }, evidence: 'actual setup completion' }, f.checkpoint);
  const consumed = await stageDispatch(f.state, 'batch', 'task-ab', f);
  assert.equal(consumed.nativeCall, null); assert.equal(f.state.batches[0].tasks[0].threadId, 'real-thread');
  assert.equal(f.state.operations.length, 1);
});
