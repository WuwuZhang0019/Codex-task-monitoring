// 日期：2026-11-12。真实隔离 HTTP、授权、版本、事件回放与重开恢复。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../tests/helpers/light-e-fixture.mjs';
import { createCoordination, stageHostProject, verifyHostProject } from '../../plugins/task-workbench/skills/workbench-handoff/scripts/coordination.mjs';

test('协调检查点真实服务保存/回读/冲突/事件查询/冷重开，不修改步骤与绑定', async t => {
  const f = await fixture(t), before = await f.read();
  const state = createCoordination({ id: 'isolated-coordination', projectId: f.main.projectId, planId: f.main.planId,
    coordinator: { threadId: f.old.threadId, hostId: 'local' }, authorization: { mode: 'execute', permissions: ['createChat', 'dispatch', 'collect'],
      source: { threadId: f.old.threadId, locator: 'human-test-turn', quote: '仅在测试项目协调派发' }, lineIds: ['fixture'], stepIds: [before.steps[0].id] } });
  // 日期：2026-11-13。项目添加未知/成功日志同样通过服务持久化，UI 结果使用明确隔离替身。
  const pending = await stageHostProject(state, { target: { lineId: 'fixture', hostId: 'local', worktreePath: f.repo,
    branch: 'main', stepIds: [before.steps[0].id] }, projects: [],
    capabilities: { computerUse: { status: 'available', evidence: 'isolated adapter only' } } }, async () => {});
  assert.equal(pending.operation.status, 'pending');
  const input = { ...await f.base('coordination-save'), coordinationId: state.id, expectedCheckpointRevision: 0, state };
  const saved = f.accepted(await f.call(f.old, 'workbench_save_coordination', input)); assert.equal(saved.checkpointRevision, 1);
  assert.deepEqual(f.accepted(await f.call(f.old, 'workbench_save_coordination', input)), saved);
  const query = f.accepted(await f.call(f.old, 'workbench_query_event', { projectId: f.main.projectId, operation: 'coordinate', eventId: input.eventId }));
  assert.equal(query.state, 'committed');
  const read = async actor => f.call(actor, 'workbench_get_coordination', { projectId: f.main.projectId, planId: f.main.planId, coordinationId: state.id });
  assert.deepEqual(f.accepted(await read(f.old)).checkpoint.state, state);
  const conflict = await f.call(f.old, 'workbench_save_coordination', { ...input, ...await f.base('coordination-conflict') });
  assert.equal(conflict.error.code, 'REVISION_CONFLICT');
  const foreign = { ...input, ...await f.base('foreign-coordination'), expectedCheckpointRevision: 1, state: { ...state, projectId: 'other' } };
  assert.equal((await f.call(f.old, 'workbench_save_coordination', foreign)).error.code, 'INVALID_INPUT');
  const outsider = (await f.ui('grants', { projectKeys: ['foreign/project'], threadId: 'outsider', hostId: 'local', worktreeRoots: [f.repo], acknowledged: true })).value;
  assert.equal((await read(outsider)).error.code, 'FORBIDDEN');
  await f.reopen();
  assert.deepEqual(f.accepted(await read(f.next)).checkpoint.state, state, '新协调聊天可恢复授权项目检查点');
  await verifyHostProject(state, { operationId: pending.operation.operationId,
    projects: [{ projectId: 'isolated-host-project', hostId: 'local', path: f.repo }],
    evidence: 'isolated host adapter, not actual desktop' }, async () => {});
  f.accepted(await f.call(f.next, 'workbench_save_coordination', { ...await f.base('project-verified'),
    coordinationId: state.id, expectedCheckpointRevision: 1, state }));
  await f.reopen();
  assert.deepEqual(f.accepted(await read(f.next)).checkpoint.state, state, '回读核验后的固定项目身份冷重开保留');
  const after = await f.read(); assert.deepEqual(after.steps, before.steps); assert.deepEqual(after.bindings, before.bindings); assert.deepEqual(after.executions, before.executions);
});
