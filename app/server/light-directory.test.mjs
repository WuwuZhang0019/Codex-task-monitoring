// 日期：2026-11-13。普通目录经真实 MCP/HTTP 完成任务，Git 变更及授权门禁仍生效。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, HttpError } from './index.mjs';
import { prepareLightPlan } from './light-import.mjs';
import { createLightBridge } from '../mcp/light-bridge.mjs';
import { inspectWorkspace } from '../../plugins/task-workbench/skills/workbench-handoff/scripts/context-ledger.mjs';

test('non-Git project binds and completes three sequential steps through MCP, then rejects context drift and revocation', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'light-directory-'));
  const workspace = path.join(root, 'user-project'); await mkdir(workspace);
  const ownerToken = 'd'.repeat(64);
  const server = await createServer({ dataDir: path.join(root, 'data'), env: {}, lightAccessEnabled: true,
    authorize(req, pathname) {
      if (pathname !== '/api/light-mcp' && req.headers.authorization !== `Bearer ${ownerToken}`) throw new HttpError(403, 'FORBIDDEN');
    } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, body) => {
    const response = await fetch(`${endpoint}/api/light-access/${route}`, { method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); return response.json();
  };
  const grant = await post('connect', { acknowledged: true });
  const bridge = createLightBridge({ endpoint, token: grant.token });
  const client = new Client({ name: 'codex-directory-test', version: '1' });
  t.after(async () => { await client.close(); await bridge.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const [a, b] = InMemoryTransport.createLinkedPair(); await bridge.connect(b); await client.connect(a);
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
  const accepted = value => { assert.equal(value?.status, 'accepted', JSON.stringify(value)); return value.result; };
  const observed = await inspectWorkspace(workspace);
  assert.equal(observed.branch, null); assert.equal(observed.head, null);
  const context = { sessionGroup: 'A', threadId: 'directory-chat', hostId: 'local', folderId: null,
    worktreeOrdinal: 1, worktreePath: observed.worktreePath, branch: null, head: null, trust: 'declared' };
  const text = '# 目录任务\n日期：2026-11-13\n## 实施路线与出口\n| 阶段 | 前置 | 范围 | 出口 |\n| A 第一步 | 无 | 空 | 返回成功 |\n| B 第二步 | A | 空 | 返回成功 |\n| C 第三步 | B | 空 | 返回成功 |\n';
  const candidate = prepareLightPlan({ text, sourcePath: path.join(workspace, 'plan.md'), version: '1',
    projectKey: 'directory/project', planKey: 'directory/plan', name: '普通目录任务', date: '2026-11-13', context });
  const source = Object.fromEntries(Object.entries(candidate.plans[0].source).filter(([key]) => key !== 'trust'));
  const registration = { schemaVersion: 'light-1.0', expectedRevision: 0,
    eventId: 'register', source, occurredAt: '2026-11-13T10:00:00+08:00', snapshot: candidate };
  const publication = await post('confirm-publication', { principal: grant.principal, operation: 'register', input: registration, acknowledged: true });
  const registered = accepted(await call('workbench_register_plan', { ...registration, confirmationGrant: publication.confirmationGrant }));
  const projectId = registered.projectId, planId = registered.planIds[0];
  let snapshot;
  const read = async () => snapshot = accepted(await call('workbench_get_project', { projectId }));
  await read();
  const base = eventId => ({ schemaVersion: 'light-1.0', projectId, planId, eventId, source,
    expectedRevision: snapshot.projects[0].revision, occurredAt: '2026-11-13T10:00:00+08:00', reason: '普通目录回归' });
  const propose = { ...base('bind'), action: 'propose', context, stepIds: snapshot.steps.map(s => s.id),
    bindingId: null, expectedBindingRevision: null, confirmationGrant: null };
  const bound = accepted(await call('workbench_bind_context', propose)); assert.equal(bound.state, 'confirmed');
  assert.deepEqual(accepted(await call('workbench_bind_context', propose)), bound);
  await read();
  const beforeInvalid = structuredClone(snapshot);
  for (const [suffix, invalidContext] of [
    ['false-branch', { ...context, branch: 'main' }],
    ['false-head', { ...context, head: 'invented-head' }],
    ['missing-directory', { ...context, worktreePath: path.join(root, 'missing') }],
  ]) {
    assert.equal((await call('workbench_bind_context', { ...propose, ...base(suffix), context: invalidContext })).error.code, 'STALE_BINDING');
    await read(); assert.deepEqual(snapshot, beforeInvalid);
  }
  const bindingFields = { bindingId: bound.bindingId, bindingRevision: bound.bindingRevision };
  let start;
  for (const step of snapshot.steps) {
    const reserved = accepted(await call('workbench_reserve_execution', base(`reserve-${step.code}`))); await read();
    start = { ...base(`start-${step.code}`), ...bindingFields, stepId: step.id, executionId: reserved.executionId,
      targetStatus: 'running', evidence: [], checks: [], blocker: null, reopen: null, successorImpact: null };
    if (step.code === 'A') {
      const moved = path.join(root, 'moved-project'); await rename(workspace, moved);
      try { assert.equal((await call('workbench_update_step_status', { ...start, ...base('directory-disappeared') })).error.code, 'STALE_BINDING'); }
      finally { await rename(moved, workspace); }
      await read();
    }
    accepted(await call('workbench_update_step_status', start)); await read();
    const proof = { evidenceId: `proof-${step.code}`, location: 'fixture://returned-success', method: '模拟返回值', deliveryVersion: '1', result: 'passed' };
    accepted(await call('workbench_update_step_status', { ...start, ...base(`finish-${step.code}`), targetStatus: 'completed',
      evidence: [proof], checks: step.conditions.map(c => ({ ...c, result: 'passed', evidenceIds: [proof.evidenceId] })) }));
    await read();
  }
  assert.ok(snapshot.steps.every(step => step.status === 'completed' && step.acceptance === 'passed'));
  accepted(await call('workbench_complete_plan', { ...base('complete'), checks: [], evidence: snapshot.steps.flatMap(step => step.evidence) })); await read();
  const before = structuredClone(snapshot);
  // 从非 Git 改为 Git 后，旧目录绑定不得继续使用。
  execFileSync('git', ['init', '-b', 'main', workspace], { windowsHide: true, stdio: 'pipe' });
  execFileSync('git', ['-C', workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--allow-empty', '-m', 'fixture'], { windowsHide: true, stdio: 'pipe' });
  assert.equal((await call('workbench_update_step_status', { ...start, ...base('git-drift') })).error.code, 'STALE_BINDING');
  assert.equal((await call('workbench_bind_context', { ...propose, ...base('git-downgrade') })).error.code, 'STALE_BINDING');
  await read(); assert.deepEqual(snapshot, before);
  await post('revoke', { principal: grant.principal, acknowledged: true });
  assert.equal((await call('workbench_get_project', { projectId })).error.code, 'FORBIDDEN');
});

test('directory inspection rejects files, missing directories, broken repositories and Git subdirectories', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'light-directory-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'file'), 'fixture');
  await assert.rejects(inspectWorkspace(path.join(root, 'file')), /WORKSPACE_DIRECTORY_REQUIRED/);
  await assert.rejects(inspectWorkspace(path.join(root, 'missing')), /ENOENT/);
  const probe = `import {inspectWorkspace} from ${JSON.stringify(new URL('../../plugins/task-workbench/skills/workbench-handoff/scripts/context-ledger.mjs', import.meta.url).href)}; console.log(JSON.stringify(await inspectWorkspace(process.argv[1])));`;
  const withoutGit = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe, root], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, PATH: path.join(root, 'no-tools') }, stdio: 'pipe',
  }));
  assert.equal(withoutGit().branch, null, '普通目录不依赖安装 Git');
  await mkdir(path.join(root, '.git')); // 损坏仓库不能当普通目录。
  await assert.rejects(inspectWorkspace(root));
  assert.throws(withoutGit, 'Git 不可用时也不能绕过现存仓库元数据');
  await rename(path.join(root, '.git'), path.join(root, 'broken-git'));
  execFileSync('git', ['init', '-b', 'main', root], { windowsHide: true, stdio: 'pipe' });
  execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--allow-empty', '-m', 'fixture'], { windowsHide: true, stdio: 'pipe' });
  const child = path.join(root, 'child'); await mkdir(child);
  await assert.rejects(inspectWorkspace(child), /WORKTREE_ROOT_MISMATCH/);
});
