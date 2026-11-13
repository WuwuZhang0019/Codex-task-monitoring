// 日期：2026-11-13。项目 API 缺失时的自动化分流与真实项目回读门禁。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { createCoordination, planHostProjects, stageHostProject, verifyHostProject, validateCoordination,
  recoveryReport, reconcileNotSubmitted, saveCheckpoint } from '../../plugins/task-workbench/skills/workbench-handoff/scripts/coordination.mjs';

const target = { lineId: 'ab', hostId: 'local', worktreePath: 'G:\\test\\ab', branch: 'codex/ab', stepIds: ['A', 'B'], label: '同名项目' };
const project = { projectId: 'real-ab', hostId: 'local', path: 'g:/test/AB/', label: '其他名称' };
const inspect = async (directory, branch) => ({ worktreePath: directory, branch, repositoryRoot: directory, gitCommonDir: directory + '/.git', head: 'a'.repeat(40) });
const capabilities = { createProject: { status: 'unavailable', evidence: 'discovered tools: list_projects/create_thread; no project creation tool' },
  computerUse: { status: 'available', evidence: 'computer skill permits this target; target window selected' } };
const stateOf = () => createCoordination({ id: 'prepare-projects', coordinator: { threadId: 'coordinator', hostId: 'local' },
  authorization: { mode: 'execute', source: { threadId: 'human', locator: 'turn-1', quote: '按四项目方案创建执行聊天并派发' },
    permissions: ['createChat', 'dispatch', 'collect'], lineIds: ['ab'], stepIds: ['A', 'B'] } });
const input = (projects = []) => ({ target, targets: [target], projects, capabilities });
const checkpoint = async () => {};

test('按真实 host/路径复用项目，忽略名称，不因缺少创建 API 要求手动添加', async () => {
  const state = stateOf(), before = structuredClone(state);
  const plan = await planHostProjects(state, input([project]), inspect);
  assert.equal(plan.ready, true);
  assert.equal(plan.projects[0].hostProjectId, 'real-ab');
  assert.equal(plan.projects[0].action, null);
  assert.deepEqual(state, before);
  const fallback = await planHostProjects(state, input([{ ...project, path: 'G:\\other', label: target.label }]), inspect);
  assert.equal(fallback.projects[0].status, 'needsCreation');
  assert.equal(fallback.projects[0].action.route, 'computerUse');
  assert.equal(fallback.projects[0].hostProjectId, null);
});

test('优先实际原生创建工具；UI 被禁止、缺证据或远程宿主不能冒充自动化可用', async () => {
  const args = input();
  args.capabilities = { ...capabilities, createProject: { status: 'available', toolName: 'actual_project_tool', evidence: 'actual schema inspected' } };
  assert.equal((await planHostProjects(stateOf(), args, inspect)).projects[0].action.toolName, 'actual_project_tool');
  for (const status of ['forbidden', 'unavailable', 'failed', 'unknown']) {
    args.capabilities = { ...capabilities, computerUse: { status, evidence: 'actual restriction or error' } };
    const item = (await planHostProjects(stateOf(), args, inspect)).projects[0];
    assert.equal(item.action, null); assert.equal(item.reason, 'HOST_PROJECT_AUTOMATION_UNAVAILABLE');
    assert.equal(item.capabilities.computerUse.status, status);
  }
  args.capabilities = { computerUse: { status: 'available' } };
  assert.equal((await planHostProjects(stateOf(), args, inspect)).projects[0].action, null);
  args.capabilities = capabilities; args.targets = [{ ...target, hostId: 'remote-host' }];
  assert.equal((await planHostProjects(stateOf(), args, inspect)).projects[0].action, null);
  assert.equal((await planHostProjects(stateOf(), args)).projects[0].reason, 'REMOTE_INSPECTION_ADAPTER_REQUIRED');
});

test('仅核对、撤销、越界、缺创建聊天权限不能触发添加项目；普通登记不必走此流程', async () => {
  for (const mutate of [s => s.authorization.mode = 'inspect', s => s.authorization.mode = 'generate',
    s => s.authorization.revokedAt = '2026-11-13', s => s.authorization.lineIds = [],
    s => s.authorization.stepIds = ['A'], s => s.authorization.permissions = ['dispatch']]) {
    const state = stateOf(); mutate(state); const before = structuredClone(state);
    const result = await stageHostProject(state, input(), checkpoint, inspect);
    assert.equal(result.reason, 'CREATE_CHAT_AUTHORIZATION_REQUIRED');
    assert.equal(result.action, null); assert.deepEqual(state, before);
  }
});

test('重复项目不能任取同名身份；指定 ID 必须同时匹配目录及宿主', async () => {
  const args = input([project, { ...project, projectId: 'second-ab' }]);
  assert.equal((await planHostProjects(stateOf(), args, inspect)).projects[0].reason, 'HOST_PROJECT_AMBIGUOUS');
  args.targets = [{ ...target, hostProjectId: 'second-ab' }];
  assert.equal((await planHostProjects(stateOf(), args, inspect)).projects[0].hostProjectId, 'second-ab');
  args.targets = [{ ...target, hostProjectId: 'wrong' }];
  assert.equal((await planHostProjects(stateOf(), args, inspect)).projects[0].reason, 'HOST_PROJECT_ID_OR_PATH_MISMATCH');
  const otherHost = await planHostProjects(stateOf(), input([{ ...project, hostId: 'remote' }]), inspect);
  assert.equal(otherHost.projects[0].status, 'needsCreation');
});

test('目录不存在或分支错误先报告实际检查错误，不尝试添加或新建工作树', async () => {
  for (const error of ['ENOENT', 'WORKTREE_BRANCH_MISMATCH']) {
    const state = stateOf();
    const result = await stageHostProject(state, input(), checkpoint, async () => { throw Error(error); });
    assert.equal(result.reason, 'WORKSPACE_INSPECTION_FAILED'); assert.equal(result.detail, error);
    assert.equal(result.action, null); assert.equal(state.operations.length, 0);
  }
});

test('添加意图先持久化，未知结果不重复创建，换 UI/API 路径仍沿用原操作键', async () => {
  const state = stateOf(); let saves = 0;
  const staged = await stageHostProject(state, input(), async value => {
    saves++; assert.equal(value.operations[0].status, 'pending');
    assert.equal(value.operations[0].resultUnknown, true);
  }, inspect);
  assert.ok(saves > 0); assert.equal(staged.action.route, 'computerUse');
  const args = input(); args.capabilities = { createProject: { status: 'available', toolName: 'native_tool', evidence: 'schema' } };
  const retry = await stageHostProject(state, args, checkpoint, inspect);
  assert.equal(retry.action, null); assert.equal(retry.next, 'verify-project');
  assert.equal(retry.operation.operationId, staged.operation.operationId);
  assert.equal(recoveryReport(state).unknownOperations.length, 1);
  assert.equal(state.operations.length, 1);
});

test('点击成功、空列表、其他宿主或错误路径不算已创建；真实列表回读后才能登记固定 ID', async () => {
  const state = stateOf(), staged = await stageHostProject(state, input(), checkpoint, inspect);
  const operationId = staged.operation.operationId;
  for (const projects of [[], [{ ...project, hostId: 'remote' }], [{ ...project, path: 'G:\\wrong' }]]) {
    await assert.rejects(verifyHostProject(state, { operationId, projects, evidence: 'fresh actual list_projects result' }, checkpoint), /NOT_CONFIRMED/);
    assert.equal(state.operations[0].resultUnknown, true);
  }
  await assert.rejects(verifyHostProject(state, { operationId, projects: [project], evidence: '' }, checkpoint), /VERIFICATION_REQUIRED/);
  const previous = structuredClone(state);
  const result = await verifyHostProject(state, { operationId, projects: [project], evidence: 'fresh list_projects actual response' }, checkpoint);
  assert.equal(result.status, 'succeeded'); assert.equal(result.targetId, project.projectId);
  assert.equal(validateCoordination(state, previous), state);
  const successful = structuredClone(state);
  const next = await stageHostProject(state, { ...input([project]), evidence: 'fresh project readback' }, checkpoint, inspect);
  assert.equal(next.next, 'map'); assert.equal(next.action, null);
  assert.equal(validateCoordination(state, successful), state);
});

test('明确未调用后可安全切换自动化路径重试，未找到不能证明未提交', async () => {
  const state = stateOf(), first = await stageHostProject(state, input(), checkpoint, inspect);
  const operationId = first.operation.operationId;
  await assert.rejects(reconcileNotSubmitted(state, { operationId, proof: 'notFoundInList', evidence: 'none' }, checkpoint), /NON_SUBMISSION_PROOF/);
  await reconcileNotSubmitted(state, { operationId, proof: 'nativeRequestNotInvoked', evidence: 'staged but native/UI action never invoked' }, checkpoint);
  const args = input(); args.capabilities = { createProject: { status: 'available', toolName: 'new_actual_tool', evidence: 'schema' } };
  const next = await stageHostProject(state, args, checkpoint, inspect);
  assert.equal(next.action.route, 'native'); assert.equal(next.operation.operationId, operationId);
  assert.equal(state.operations.length, 1);
});

test('CLI 用真实 Git 目录完成准备、落盘、回读和恢复，不依赖开发仓库路径', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'host-project-test-'));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); });
  const git = args => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
  git(['init', '-b', 'codex/ab']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
  const file = path.join(root, 'checkpoint.json'), inputFile = path.join(root, 'input.json');
  await saveCheckpoint(file, stateOf());
  const args = input(); args.target = { ...target, worktreePath: root }; args.targets = [args.target];
  const cli = path.resolve('plugins/task-workbench/skills/workbench-handoff/scripts/coordination-cli.mjs');
  const run = async (command, value) => {
    await writeFile(inputFile, JSON.stringify(value));
    return JSON.parse(execFileSync(process.execPath, [cli, command, file, inputFile], { encoding: 'utf8', windowsHide: true }));
  };
  assert.equal((await run('projects', args)).projects[0].action.route, 'computerUse');
  const staged = await run('stage-project', args);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).operations[0].status, 'pending');
  const result = await run('verify-project', { operationId: staged.operation.operationId,
    projects: [{ ...project, path: root }], evidence: 'isolated adapter result; not native desktop verification' });
  assert.equal(result.targetId, project.projectId);
  assert.equal((await run('recover', {})).unknownOperations.length, 0);
});
