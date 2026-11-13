// 日期：2026-11-13。项目 API 缺失时的自动化分流与真实项目回读门禁。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createCoordination, planHostProjects, stageHostProject, verifyHostProject, validateCoordination,
  recoveryReport, reconcileNotSubmitted, saveCheckpoint, prepareHostProject, workspaceProjectLink, openProjectWorkspace } from '../../plugins/task-workbench/skills/workbench-handoff/scripts/coordination.mjs';

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

test('公开接口与官方深链自动准备，公开 UUID 不冒充宿主 ID，回读后才能完成', async () => {
  const state = stateOf(), calls = [], disk = [];
  const native = { id: 'public-registry-id', name: 'ab', roots: [{ path: target.worktreePath }] };
  const client = { list: async () => ({ data: [] }), create: async request => {
    assert.equal(disk.at(-1).operations[0].publicRequest.idempotencyKey, request.idempotencyKey);
    assert.deepEqual(request.roots, native.roots); calls.push('create'); return { project: native };
  }, read: async () => ({ project: native }), close() {} };
  const options = { client, inspect, openWorkspace: async directory => { assert.equal(directory, target.worktreePath); calls.push('open'); } };
  const save = async value => disk.push(structuredClone(value));
  const result = await prepareHostProject(state, input(), save, options);
  assert.deepEqual(calls, ['create', 'open']); assert.equal(result.next, 'verify-project');
  assert.equal(result.operation.publicProjectId, 'public-registry-id');
  assert.equal(result.operation.targetId, null); assert.equal(result.operation.status, 'pending');
  await prepareHostProject(state, input(), save, options); assert.deepEqual(calls, ['create', 'open']);
  const verified = await verifyHostProject(state, { operationId: result.operation.operationId, projects: [project], evidence: 'actual desktop host list' }, save);
  assert.equal(verified.targetId, 'real-ab'); assert.notEqual(verified.targetId, native.id);
});

test('多页复用公开项目不重复创建，身份错配与创建未知不继续打开或重发', async () => {
  for (const scenario of ['reuse', 'mismatch', 'unknown']) {
    let reads = 0, creates = 0, opens = 0;
    const state = stateOf(), native = { id: 'public-id', roots: [{ path: target.worktreePath }] };
    const options = { inspect, openWorkspace: async () => { opens++; }, client: {
      list: async () => ({ data: reads++ ? (scenario === 'reuse' ? [native] : []) : [], nextCursor: reads === 1 ? 'page2' : null }),
      create: async () => { creates++; if (scenario === 'unknown') throw Object.assign(Error('lost'), { code: 'HOST_PROJECT_RESULT_UNKNOWN', resultUnknown: true }); return { project: native }; },
      read: async () => ({ project: scenario === 'mismatch' ? { ...native, roots: [{ path: 'G:\\wrong' }] } : native }), close() {},
    } };
    const result = await prepareHostProject(state, input(), checkpoint, options);
    assert.equal(opens, scenario === 'reuse' ? 1 : 0); assert.equal(creates, scenario === 'reuse' ? 0 : 1);
    assert.equal(result.operation.status, 'pending');
    await prepareHostProject(state, input(), checkpoint, options);
    assert.equal(opens, scenario === 'reuse' ? 1 : 0); assert.equal(creates, scenario === 'reuse' ? 0 : 1);
  }
});

test('公开实验接口缺失仍可使用官方工作区入口，原生宿主项目已存在则无外部操作', async () => {
  let opens = 0, lists = 0;
  const options = { inspect, openWorkspace: async () => { opens++; }, client: { list: async () => {
    lists++; throw Object.assign(Error('Method not found'), { code: 'HOST_PROJECT_REQUEST_REJECTED', rpcCode: -32601 });
  }, close() {} } };
  const result = await prepareHostProject(stateOf(), input(), checkpoint, options);
  assert.equal(opens, 1); assert.equal(result.operation.desktopOpen.state, 'requested');
  assert.equal(result.operation.targetId, null);
  assert.equal((await prepareHostProject(stateOf(), input([project]), checkpoint, options)).status, 'ready');
  assert.equal(lists, 1); assert.equal(opens, 1);
  const blocked = stateOf(); blocked.authorization.mode = 'inspect';
  await prepareHostProject(blocked, input(), checkpoint, options); assert.equal(opens, 1);
});

test('官方深链只包含精确目录，无自动提示词，特殊字符不进入 shell 命令', async () => {
  const directory = "G:\\测试 空格\\a'&$();#?目录";
  const uri = workspaceProjectLink(directory), parsed = new URL(uri);
  assert.equal(parsed.searchParams.get('path'), directory); assert.equal(parsed.searchParams.size, 1);
  const calls = [];
  await openProjectWorkspace(directory, async (...args) => { calls.push(args); }, 'win32');
  assert.equal(calls[0][0], 'powershell.exe');
  const command = Buffer.from(calls[0][1].at(-1), 'base64').toString('utf16le');
  assert.equal(command, `Start-Process -FilePath '${uri}' -WindowStyle Hidden`);
  assert.equal(uri.includes("'"), false); assert.equal(calls[0][2].shell, false);
  assert.throws(() => workspaceProjectLink('relative/path'), /ABSOLUTE/);
});

test('公开列表权限或参数拒绝不尝试其他入口', async () => {
  for (const rpcCode of [-32000, -32602]) {
    let opened = false;
    const result = await prepareHostProject(stateOf(), input(), checkpoint, { inspect,
      openWorkspace: async () => { opened = true; }, client: {
        list: async () => { throw Object.assign(Error('denied'), { code: 'HOST_PROJECT_REQUEST_REJECTED', rpcCode }); }, close() {},
      } });
    assert.equal(opened, false); assert.equal(result.operation.publicError.rpcCode, rpcCode);
  }
});

test('创建丢响应后只读对账成功，接续尚未调用的目录入口且不重发创建', async () => {
  const state = stateOf(), native = { id: 'persisted-project', roots: [{ path: target.worktreePath }] };
  let stored = false, creates = 0, opens = 0;
  const options = { inspect, openWorkspace: async () => { opens++; }, client: {
    list: async () => ({ data: stored ? [native] : [] }),
    create: async () => { creates++; stored = true; throw Object.assign(Error('lost'), { code: 'HOST_PROJECT_RESULT_UNKNOWN', resultUnknown: true }); },
    read: async () => ({ project: native }), close() {},
  } };
  await prepareHostProject(state, input(), checkpoint, options);
  assert.equal(opens, 0);
  const restored = structuredClone(state);
  await prepareHostProject(restored, input(), checkpoint, options);
  assert.equal(creates, 1); assert.equal(opens, 1);
  assert.equal(restored.operations[0].targetId, null);
  await prepareHostProject(restored, input(), checkpoint, options);
  assert.equal(opens, 1);
});

test('CLI 用真实 Git 目录完成准备、落盘、回读和恢复，不依赖开发仓库路径', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'host-project-test-'));
  t.after(async () => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); });
  const git = args => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
  git(['init', '-b', 'codex/ab']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
  const file = path.join(root, 'checkpoint.json'), inputFile = path.join(root, 'input.json');
  await saveCheckpoint(file, stateOf());
  const args = input(); args.target = { ...target, worktreePath: root }; args.targets = [args.target];
  const cli = fileURLToPath(new URL('../../plugins/task-workbench/skills/workbench-handoff/scripts/coordination-cli.mjs', import.meta.url));
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
