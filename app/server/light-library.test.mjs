// Date: 2026-11-12. Real storage fixtures exercise archive, deletion, references and rollback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPersistence } from './persistence.mjs';
import { createRequests } from './business-requests.mjs';
import { createLightService } from './light-service.mjs';
import { createLightLibrary } from './light-library.mjs';
import { createLightPanel } from './light-panel.mjs';
import { prepareLightPlan } from './light-import.mjs';
import { validateLightSnapshot } from './light-model.mjs';
import { runtimeExitStatus } from './runtime-lifecycle.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'task-library-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const text = '# Task library\n日期：2026-11-12\n## 实施路线与出口\n| 阶段 | 前置 | 范围 | 出口 |\n| A 数据 | 用户已确认 | 数据 | 已保存 |\n| B 展示 | A | 展示 | 可展示 |\n';
  const file = path.join(root, 'source.md'); await writeFile(file, text);
  const persistence = await createPersistence(root);
  const service = createLightService(persistence, createRequests(persistence), { authorize: () => true });
  const snapshot = prepareLightPlan({ text, sourcePath: file, version: 'library-test', projectKey: 'test/project', planKey: 'test/plan', name: 'Library', date: '2026-11-12',
    context: { sessionGroup: 'test', threadId: 'test', hostId: 'local', folderId: null, worktreeOrdinal: 1, worktreePath: root, branch: 'main', head: null, trust: 'declared' } });
  snapshot.steps[1].dependsOn = [];
  snapshot.routes[0].stepKeys = [snapshot.steps[0].key];
  snapshot.routes.push({ ...snapshot.routes[0], key: 'test/route-b', label: 'Route B', order: 2, stepKeys: [snapshot.steps[1].key] });
  await service.register('owner', { eventId: 'register', expectedRevision: 0, snapshot });
  const library = createLightLibrary(persistence), panel = createLightPanel(persistence);
  const key = snapshot.routes[0].key;
  const change = (action, target = key, extra = {}) => library.change(action, { key: target, expectedRevision: persistence.read('light').snapshot.revision, acknowledged: true, ...extra });
  return { root, persistence, service, snapshot, panel, key, change };
}

test('archive and restore persist, retain the source data and keep project business revision', async t => {
  const { root, persistence, panel, key, change } = await fixture(t);
  const before = persistence.read('light').snapshot;
  await change('archive');
  assert.equal((await panel.read()).library.archived[0].key, key);
  assert.deepEqual(persistence.read('light').snapshot.steps, before.steps);
  assert.equal(persistence.read('light').snapshot.projects[0].revision, before.projects[0].revision);
  const reopened = await createPersistence(root);
  assert.equal((await createLightPanel(reopened).read()).library.archived[0].key, key);
  await createLightLibrary(reopened).change('restore', { key, expectedRevision: reopened.read('light').snapshot.revision, acknowledged: true });
  assert.deepEqual((await createLightPanel(reopened).read()).library.archived, []);
});

test('publication cannot silently replace an archived route identity or redistribute its steps', async t => {
  const { persistence, service, snapshot, change } = await fixture(t);
  await change('archive');
  const before = persistence.read('light');
  const candidate = structuredClone(snapshot); candidate.routes[0].key = 'replacement-route';
  const input = { eventId: 'revise-archived', projectId: before.snapshot.projects[0].id, planId: before.snapshot.plans[0].id,
    expectedRevision: before.snapshot.projects[0].revision, snapshot: candidate, reason: 'change route identity' };
  await assert.rejects(service.revise('owner', input), /ARCHIVED_TASK/);
  assert.deepEqual(persistence.read('light'), before);
  await change('restore');
  await service.revise('owner', input);
  assert.ok(persistence.read('light').snapshot.routes.some(item => item.key === 'replacement-route'));
});

test('deletion removes actual route and steps, cleans related state, preserves the other route and rejects old publications', async t => {
  const { root, persistence, snapshot, service, key, change } = await fixture(t);
  await change('archive');
  await persistence.run(() => {
    persistence.write('lightPanelPreferences', { selected: snapshot.steps[0].key, focus: [key], collapsed: [], scroll: { ['island/route/' + key]: 20 }, y: {} });
    persistence.write('lightOutbox', {});
  });
  const before = persistence.read('light').snapshot;
  await change('delete');
  const current = persistence.read('light').snapshot;
  assert.equal(current.steps.length, 1); assert.equal(current.routes.length, 1);
  assert.deepEqual(current.steps[0], before.steps[1]); assert.deepEqual(current.routes[0], before.routes[1]);
  assert.equal(current.projects[0].revision, before.projects[0].revision + 1);
  assert.deepEqual(current.plans[0].stageKeys, [current.steps[0].key]); assert.equal(current.plans[0].stageCount, 1);
  assert.deepEqual(persistence.read('lightLibrary').archived, []);
  assert.equal(persistence.read('lightPanelPreferences').selected, '');
  assert.deepEqual(persistence.read('lightPanelPreferences').focus, []);
  assert.deepEqual(persistence.read('lightPanelPreferences').scroll, {});
  validateLightSnapshot(current);
  assert.deepEqual((await createPersistence(root)).read('light').snapshot, current);
  await assert.rejects(Promise.resolve().then(() => service.register('owner', { eventId: 'register', expectedRevision: 0, snapshot })), /DELETED_TASK/);
  await change('archive', current.routes[0].key); await change('delete', current.routes[0].key);
  const empty = persistence.read('light').snapshot;
  for (const group of ['projects', 'plans', 'steps', 'routes', 'bindings', 'executions', 'supplements', 'events']) assert.deepEqual(empty[group], []);
});

test('stale revisions, missing acknowledgment, non-archived deletes, external dependencies and running work fail without mutation', async t => {
  const { persistence, snapshot, key, change } = await fixture(t);
  const original = persistence.read('light');
  for (const [action, extra, message] of [['archive', { acknowledged: false }, /INVALID_INPUT/], ['archive', { expectedRevision: -1 }, /REVISION_CONFLICT/], ['delete', {}, /ARCHIVE_REQUIRED/]]) {
    await assert.rejects(Promise.resolve().then(() => change(action, key, extra)), message);
    assert.deepEqual(persistence.read('light'), original);
  }
  await change('archive');
  await persistence.run(() => {
    const value = persistence.read('light'); value.snapshot.steps[1].dependsOn = [value.snapshot.steps[0].key]; persistence.write('light', value);
  });
  const before = persistence.read('light');
  await assert.rejects(Promise.resolve().then(() => change('delete')), /REFERENCED_TASK/);
  assert.deepEqual(persistence.read('light'), before);
  await persistence.run(() => {
    const value = persistence.read('light'); value.snapshot.steps[1].dependsOn = []; value.snapshot.steps[0].status = 'running'; persistence.write('light', value);
  });
  await assert.rejects(Promise.resolve().then(() => change('delete')), /ACTIVE_TASK/);
  assert.equal(persistence.read('light').snapshot.steps[0].key, snapshot.steps[0].key);
});

test('deleted route removes its execution, evidence and events while a shared binding retains the other route', async t => {
  const { persistence, change } = await fixture(t);
  await persistence.run(() => {
    const value = persistence.read('light'), snapshot = value.snapshot, [first, second] = snapshot.steps;
    const context = { sessionGroup: 'test', threadId: 'test', hostId: 'local', folderId: null, worktreeOrdinal: 1, worktreePath: 'G:/test', branch: 'main', head: null, trust: 'declared' };
    snapshot.bindings.push({ key: 'shared-binding', id: 'binding-id', projectKey: first.projectKey, planKey: first.planKey,
      stepKeys: [first.key, second.key], bindingRevision: 1, state: 'confirmed', context, confirmationRef: 'confirmation', revokedAt: null });
    first.bindingKey = second.bindingKey = 'shared-binding';
    snapshot.executions.push({ key: 'first-execution', id: 'execution-id', projectKey: first.projectKey, planKey: first.planKey, stepKeys: [first.key],
      bindingKey: 'shared-binding', outcome: 'cancelled', startedAt: '2026-11-12T01:00:00Z', endedAt: '2026-11-12T02:00:00Z', handoffConclusion: null });
    first.executionKey = 'first-execution';
    snapshot.events.push({ eventId: 'first-event', stepKey: first.key, executionKey: 'first-execution', fromStatus: null, toStatus: 'pending',
      occurredAt: '2026-11-12T01:00:00Z', receivedAt: '2026-11-12T01:00:00Z', reason: 'test', evidenceIds: [], sync: 'synced' });
    value.history.push({ input: { stepId: first.id }, content: 'deleted route history' });
    persistence.write('light', value);
  });
  await change('archive'); await change('delete');
  const value = persistence.read('light');
  assert.deepEqual(value.snapshot.executions, []); assert.deepEqual(value.snapshot.events, []); assert.deepEqual(value.history, []);
  assert.deepEqual(value.snapshot.bindings[0].stepKeys, [value.snapshot.steps[0].key]);
  assert.equal(value.snapshot.bindings[0].bindingRevision, 2);
});

test('failed preparation rolls back deletion and committed interruption recovers the complete deletion on restart', async t => {
  for (const stage of ['prepared', 'committed']) {
    const { root, persistence, key, change } = await fixture(t);
    await change('archive'); const before = persistence.read('light');
    const failing = await createPersistence(root, { fault(at) { if (at === stage) throw Error('injected interruption'); } });
    await assert.rejects(createLightLibrary(failing).change('delete', { key, acknowledged: true, expectedRevision: before.snapshot.revision }), /injected interruption/);
    const recovered = await createPersistence(root);
    if (stage === 'prepared') {
      assert.deepEqual(recovered.read('light'), before); assert.equal(recovered.read('lightLibrary').archived[0].key, key);
    } else {
      assert.equal(recovered.read('light').snapshot.routes.length, 1); assert.deepEqual(recovered.read('lightLibrary').archived, []);
    }
  }
});

test('resume notifies the original chat once for both current and previously released pause checkpoints', async t => {
  const { root, persistence, snapshot, key } = await fixture(t);
  const pausedPlans = [];
  const notifications = [];
  let uncertain = false;
  const options = {
    pauseContinuous: plans => pausedPlans.push(...plans),
    async connectResume(target) {
      assert.equal(target.worktreePath, 'G:/test');
      return {
        async notify(threadId, message) {
          notifications.push({ threadId, message });
          if (uncertain) throw Object.assign(Error('timeout'), { code: 'CODEX_DELIVERY_UNKNOWN' });
          return { turnId: 'opened-turn' };
        },
        close() {},
      };
    },
  };
  const library = createLightLibrary(persistence, options);
  await persistence.run(() => {
    const value = persistence.read('light'), s = value.snapshot, [first, second] = s.steps;
    const context = { sessionGroup: 'test', threadId: 'test', hostId: 'local', folderId: null, worktreeOrdinal: 1, worktreePath: 'G:/test', branch: 'main', head: null, trust: 'declared' };
    s.bindings.push({ key: 'active-binding', id: 'binding-id', projectKey: first.projectKey, planKey: first.planKey,
      stepKeys: [first.key, second.key], bindingRevision: 1, state: 'confirmed', context, confirmationRef: 'confirmation', revokedAt: null });
    first.status = 'running';
    first.bindingKey = 'active-binding';
    first.executionKey = 'active-execution';
    s.executions.push({ key: 'active-execution', id: 'execution-id', projectKey: first.projectKey, planKey: first.planKey,
      stepKeys: [first.key], bindingKey: 'active-binding', outcome: 'running', startedAt: '2026-11-18T00:00:00Z', endedAt: null, handoffConclusion: null });
    persistence.write('light', value);
    persistence.write('lightContinuous', { version: 1, runs: [{ id: 'run-1', planKey: first.planKey, status: 'running', enabled: true, mode: 'stages', phase: 'executing', current: null, history: [], reason: '' }] });
  });
  assert.equal(runtimeExitStatus(persistence.read('light').snapshot, persistence.read('lightContinuous').runs).allowed, false);
  await library.change('pause', { key, expectedRevision: persistence.read('light').snapshot.revision, acknowledged: true });
  const after = persistence.read('light').snapshot;
  const runs = persistence.read('lightContinuous').runs;
  assert.equal(after.steps[0].status, 'blocked');
  assert.equal(after.steps[0].blockers.find(b => b.blockerId === 'user-pause')?.resolved, false);
  assert.equal(after.executions[0].id, 'execution-id');
  assert.equal(after.executions[0].endedAt, null);
  assert.equal(runs[0].status, 'paused');
  assert.equal(runs[0].enabled, false);
  assert.deepEqual(pausedPlans, [snapshot.plans[0].key]);
  assert.deepEqual(runtimeExitStatus(after, runs), { allowed: true, activeExecutions: 0, runningSteps: 0, continuousRuns: 0 });

  // The previously deployed manual release left the original step blocked with a resolved pause.
  await persistence.run(() => {
    const value = persistence.read('light');
    const snap = value.snapshot;
    snap.steps[0].blockers[0].resolved = true;
    snap.events.push({ ...snap.events.at(-1), eventId: 'light/resume/previous-manual-release' });
    snap.revision += 1;
    persistence.write('light', value);
  });
  const waiting = persistence.read('light').snapshot;
  const input = { key, expectedRevision: waiting.revision, acknowledged: true };
  await assert.rejects(library.change('resume', { ...input, expectedRevision: after.revision }), /REVISION_CONFLICT/);
  await library.change('resume', input);
  assert.deepEqual(persistence.read('light').snapshot, waiting);
  assert.deepEqual(persistence.read('lightContinuous').runs, runs);
  const reopened = await createPersistence(root);
  await createLightLibrary(reopened, options).change('resume', input);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].threadId, 'test');
  assert.ok(notifications[0].message.startsWith(`继续父任务 「${waiting.steps[0].title}」，并同步任务岛状态。`));
  assert.match(notifications[0].message, /同步完成后等待用户指定具体工作/);
  assert.match(notifications[0].message, /不要选择、启动或执行任何子任务/);
  assert.match(notifications[0].message, /"executionId":"execution-id"/);
  assert.match(notifications[0].message, /"pauseCheckpoint":"light\/pause\//);

  await library.change('pause', input);
  uncertain = true;
  const later = { ...input, expectedRevision: persistence.read('light').snapshot.revision };
  await assert.rejects(library.change('resume', later), /TASK_RESUME_UNKNOWN/);
  await assert.rejects(library.change('resume', later), /TASK_RESUME_UNKNOWN/);
  assert.equal(notifications.length, 2);
  assert.equal(persistence.read('light').snapshot.steps[0].status, 'blocked');
});
