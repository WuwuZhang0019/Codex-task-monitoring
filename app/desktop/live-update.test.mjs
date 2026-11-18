// 日期：2026-11-18。用隔离后台进程、真实 MCP 和模拟 Codex 标准输入输出验证热交接。
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLightBridge } from '../mcp/light-bridge.mjs';
import { createPersistence } from '../server/persistence.mjs';
import { createRequests } from '../server/business-requests.mjs';
import { createLightAccess } from '../server/light-access.mjs';
import { createLightService } from '../server/light-service.mjs';
import { prepareLightPlan } from '../server/light-import.mjs';
import { RetainedSessionClient } from '../server/retained-session.mjs';
import { connectOwner, discoverOwner } from './client.mjs';
import { createIslandRecovery } from './island-launcher.mjs';
import { preparePrivateDirectory, writePrivateJson } from './private-runtime.mjs';
import { liveUpdateProtocol } from './runtime-protocol.mjs';
import { readRuntimeJson, stageRelease } from './runtime-release.mjs';
import { startService, stopService, upgradeService } from './service.mjs';

const app = fileURLToPath(new URL('../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const bundling = { absWorkingDir: app, bundle: true, format: 'esm', platform: 'node', target: 'node22',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } };
const appServer = `
  import { createInterface } from 'node:readline';
  import { appendFileSync, existsSync } from 'node:fs';
  import path from 'node:path';
  const root = process.env.WORKBENCH_TEST_UPDATE;
  let thread, turn;
  const send = value => console.log(JSON.stringify(value));
  const trace = event => appendFileSync(path.join(root, 'turns.log'), JSON.stringify({ event, pid: process.pid }) + '\\n');
  createInterface({ input: process.stdin }).on('line', line => {
    const { id, method, params } = JSON.parse(line);
    if (id === undefined) return;
    let result = {};
    if (method === 'thread/start') {
      trace('thread/start');
      thread = { id: 'fixture-thread', cwd: params.cwd, status: { type: 'idle' } };
      result = { thread };
    } else if (method === 'thread/read') result = { thread };
    else if (method === 'thread/turns/list') result = { data: turn ? [turn] : [] };
    else if (method === 'turn/start') {
      trace('turn/start');
      turn = { id: 'fixture-turn', status: 'inProgress' };
      thread.status = { type: 'active' };
      result = { turn };
      const timer = setInterval(() => {
        if (!existsSync(path.join(root, 'finish-turn'))) { trace('progress'); return; }
        clearInterval(timer);
        turn.status = 'completed';
        thread.status = { type: 'idle' };
        send({ method: 'turn/completed', params: { threadId: thread.id, turn } });
        trace('turn/completed');
      }, 50);
      const reply = setInterval(() => {
        if (!existsSync(path.join(root, 'confirm-turn'))) return;
        clearInterval(reply);
        send({ id, result });
      }, 25);
      return;
    } else if (method === 'thread/resume') {
      trace('thread/resume');
      result = { thread };
    }
    send({ id, result });
  });
`;

async function manifest(directory, files, label, protocol = liveUpdateProtocol) {
  const resources = Object.fromEntries(await Promise.all(files.map(async file => [file, digest(await readFile(path.join(directory, file)))])));
  const text = JSON.stringify({ label, liveUpdateProtocol: protocol, resources });
  await writeFile(path.join(directory, 'manifest.json'), text);
  return digest(text);
}

async function until(read, label, timeout = 25000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (value) return value;
    await delay(50);
  } while (Date.now() < deadline);
  throw Error('Timed out waiting for ' + label);
}

test('a real owner handoff preserves the worker and active turn, reconnects MCP and rolls back a bad candidate', { timeout: 120000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workbench-live-update-'));
  const data = path.join(root, 'data');
  const privateDirectory = path.join(data, 'runtime-private');
  const codexConfig = path.join(root, 'codex', 'task-workbench-light');
  const envBefore = { CODEX_HOME: process.env.CODEX_HOME, WORKBENCH_TEST_UPDATE: process.env.WORKBENCH_TEST_UPDATE };
  process.env.CODEX_HOME = path.dirname(codexConfig);
  process.env.WORKBENCH_TEST_UPDATE = root;
  let switching;
  const logs = async () => (await readFile(path.join(root, 'turns.log'), 'utf8').catch(() => ''))
    .split('\n').slice(0, -1).map(line => JSON.parse(line));
  t.after(async () => {
    await writeFile(path.join(root, 'finish-turn'), '');
    if (switching) {
      await writeFile(path.join(root, 'confirm-turn'), '');
      await writeFile(path.join(root, 'start-replacement'), '');
      await switching.catch(() => {});
    }
    const record = (await connectOwner(data).catch(() => null))?.record;
    if (record?.pid) {
      try { await stopService(data); }
      catch { try { process.kill(record.pid); } catch {} }
    }
    const sessions = await readdir(path.join(privateDirectory, 'sessions')).catch(() => []);
    for (const runId of sessions) {
      const client = new RetainedSessionClient(data, runId);
      const worker = await client.discover();
      if (worker) {
        await client.connect(worker.workerId).catch(() => {});
        await client.close();
      }
    }
    for (const [key, value] of Object.entries(envBefore)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  });
  const base = path.join(root, 'base-runtime');
  const entries = ['owner.mjs', 'runtime-protocol.mjs', 'private-runtime.mjs'];
  await mkdir(path.join(base, 'app/desktop'), { recursive: true });
  await mkdir(path.join(base, 'app/server'), { recursive: true });
  await writeFile(path.join(root, 'fixtures.mjs'), appServer);
  await Promise.all([
    copyFile(process.execPath, path.join(base, 'node.exe')),
    copyFile(path.join(app, 'server/data-lease.mjs'), path.join(base, 'app/server/data-lease.mjs')),
    ...entries.map(file => copyFile(path.join(app, 'desktop', file), path.join(base, 'app/desktop', file))),
    build({ ...bundling, entryPoints: ['server/index.mjs'], outfile: path.join(base, 'app/server/index.mjs') }),
    build({ ...bundling, stdin: { resolveDir: app, contents: `
      import { spawn } from 'node:child_process';
      import path from 'node:path';
      import { runSessionWorker } from './server/session-worker-runtime.mjs';
      import { CodexSessionClient } from './server/codex-session-client.mjs';
      await runSessionWorker(process.argv[2], new CodexSessionClient({
        executable: process.execPath,
        spawnImpl: (exe, _args, options) => spawn(exe, [path.join(process.env.WORKBENCH_TEST_UPDATE, 'fixtures.mjs')], options),
      }));
    ` }, outfile: path.join(base, 'app/server/session-worker.mjs') }),
  ]);
  const files = ['node.exe', ...entries.map(file => 'app/desktop/' + file),
    'app/server/data-lease.mjs', 'app/server/index.mjs', 'app/server/session-worker.mjs'];
  await manifest(base, files, 'original');
  await preparePrivateDirectory(privateDirectory);
  const originalRelease = await stageRelease(privateDirectory, base);
  await writePrivateJson(path.join(privateDirectory, 'release.json'), originalRelease);

  const persistence = await createPersistence(data);
  const access = createLightAccess(persistence);
  const grant = await access.connect({ appId: 'codex', acknowledged: true });
  const service = createLightService(persistence, createRequests(persistence), { authorize: access.authorize });
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const sourcePath = path.join(workspace, 'plan.md');
  const text = '# 兼容更新集成测试\n日期：2026-11-18\n## 实施路线与出口\n| 阶段 | 前置 | 范围 | 出口 |\n| A 保留执行 | 无 | 夹具 | 成功 |\n';
  await writeFile(sourcePath, text);
  const snapshot = prepareLightPlan({ text, sourcePath, version: '1', projectKey: 'fixture', planKey: 'live-update',
    name: '后台兼容更新', date: '2026-11-18', context: {
      sessionGroup: 'test', threadId: null, hostId: null, folderId: null, worktreeOrdinal: 1,
      worktreePath: workspace, branch: null, head: null, trust: 'declared',
    } });
  const registration = await service.register(grant.principal, { eventId: 'register', expectedRevision: 0, snapshot });
  await mkdir(codexConfig, { recursive: true });
  await writeFile(path.join(codexConfig, 'config.json'), JSON.stringify({ token: grant.token, dataDir: data }));
  const original = await startService(data);
  assert.equal(original.runtimeId, originalRelease.id);
  assert.equal(original.liveUpdateProtocol, liveUpdateProtocol);
  async function manager(route, body) {
    const { record, token } = await connectOwner(data);
    const response = await fetch(record.endpoint + route, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  }
  const latest = () => readRuntimeJson(path.join(data, 'aggregate.json'));
  await manager('/api/light-continuous/change', { planKey: 'live-update', action: 'start', acknowledged: true,
    expectedRevision: service.read(grant.principal, registration.projectId).projects[0].revision });
  const dispatch = await until(async () => {
    const run = (await latest()).lightContinuous.runs[0];
    if (run?.status === 'blocked') throw Error(run.reason);
    return run?.current?.turnDelivery === 'sending' && run;
  }, 'original dispatch');
  const workerFile = path.join(privateDirectory, 'sessions', dispatch.id, 'worker.json');
  const originalWorker = await readRuntimeJson(workerFile);
  await assert.rejects(stopService(data), /TASK_ACTIVE/);
  const originalScript = await readFile(path.join(base, 'app/desktop/owner.mjs'), 'utf8');
  await manifest(base, files, 'incompatible', liveUpdateProtocol + 1);
  await assert.rejects(upgradeService(data, base), /INCOMPATIBLE_RUNTIME_RELEASE/);
  assert.equal((await discoverOwner(data)).pid, original.pid);

  // Hold the replacement before it opens the writer lease. The execution must progress during this gap.
  const startupGate = `
    if (process.argv[2] !== '--probe-update') {
      const { existsSync } = await import('node:fs');
      const { setTimeout } = await import('node:timers/promises');
      while (!existsSync(path.join(process.env.WORKBENCH_TEST_UPDATE, 'start-replacement'))) await setTimeout(25);
    }
  `;
  await writeFile(path.join(base, 'app/desktop/owner.mjs'), originalScript.replace('const root =', startupGate + '\nconst root ='));
  const newRelease = await manifest(base, files, 'replacement');
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'live-update-test', version: '1' });
  const recovery = createIslandRecovery({ dataDir: data, file: path.join(root, 'missing-launcher.json'), intervalMs: 40, timeoutMs: 8000,
    launch: () => assert.fail('The updating backend owns recovery') });
  const bridge = createLightBridge({ dataDir: data, token: grant.token }, { recovery });
  await bridge.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(() => client.close());
  const project = () => client.callTool({ name: 'workbench_get_project', arguments: { projectId: registration.projectId } });
  assert.equal((await project()).structuredContent.status, 'accepted');
  // The updater can run outside the Codex process tree and must preserve the original host context.
  delete process.env.CODEX_HOME;
  switching = upgradeService(data, base);
  switching.catch(() => {});
  await until(async () => (await readRuntimeJson(path.join(privateDirectory, 'exit-result.json')))?.error === 'HANDOFF_BUSY',
    'old owner refuses handoff while start result is unknown');
  assert.equal((await discoverOwner(data)).pid, original.pid);
  assert.equal((await latest()).lightContinuous.runs[0].current.turnId, null);
  await writeFile(path.join(root, 'confirm-turn'), '');
  const checkpoint = await until(async () => {
    const run = (await latest()).lightContinuous.runs[0];
    if (run?.status === 'blocked') throw Error(run.reason);
    return run?.current?.workerId && run.current.turnId && run;
  }, 'original turn');
  const { workerId, executionId, threadId, turnId } = checkpoint.current;
  assert.equal(originalWorker.workerId, workerId);
  await until(async () => !await readRuntimeJson(path.join(data, 'owner.json')), 'old owner stops');
  const progressBefore = (await logs()).length;
  const readDuringUpgrade = project();
  await until(async () => (await logs()).length >= progressBefore + 4, 'turn processes work during the gap');
  assert.equal(await readRuntimeJson(path.join(data, 'owner.json')), null);
  await writeFile(path.join(root, 'start-replacement'), '');
  const updated = await switching;
  assert.equal(updated.upgraded, true);
  assert.equal(updated.runtimeId, newRelease);
  assert.equal((await connectOwner(data)).codexEnvironment.CODEX_HOME, path.dirname(codexConfig));
  assert.notEqual(updated.pid, original.pid);
  assert.notEqual(updated.ownerGeneration, original.ownerGeneration);
  const recovered = (await readDuringUpgrade).structuredContent;
  assert.equal(recovered.status, 'accepted');
  assert.equal(recovered.result.executions.find(item => item.id === executionId).outcome, 'running');
  const reattached = await until(async () => {
    const run = (await latest()).lightContinuous.runs[0];
    if (run.status === 'blocked') throw Error(run.reason);
    return run.recovering && run.phase === 'waiting' && run.current;
  }, 'replacement observes the same turn');
  assert.deepEqual([reattached.workerId, reattached.executionId, reattached.threadId, reattached.turnId],
    [workerId, executionId, threadId, turnId]);
  assert.equal((await readRuntimeJson(workerFile)).pid, originalWorker.pid);

  await writeFile(path.join(base, 'app/desktop/owner.mjs'), originalScript.replace('const root =',
    "if (process.argv[2] !== '--probe-update') process.exit(1);\nconst root ="));
  await manifest(base, files, 'startup-failure');
  const rolledBack = await upgradeService(data, base);
  assert.equal(rolledBack.rolledBack, true);
  assert.equal(rolledBack.runtimeId, newRelease);
  assert.notEqual(rolledBack.pid, updated.pid);
  assert.equal((await readRuntimeJson(workerFile)).workerId, workerId);

  const result = (await project()).structuredContent.result;
  const step = result.steps.find(item => item.status === 'running');
  const binding = result.bindings.find(item => item.key === step.bindingKey);
  const { trust, ...source } = result.plans[0].source;
  const proof = { evidenceId: 'fixture-after-update', location: 'fixture://turn', method: '进程持续执行', deliveryVersion: '1', result: 'passed' };
  const completion = await client.callTool({
    name: 'workbench_update_step_status', arguments: {
      schemaVersion: 'light-1.0', projectId: registration.projectId, planId: registration.planIds[0],
      expectedRevision: result.projects[0].revision, eventId: 'complete-original-turn', source, occurredAt: new Date().toISOString(),
      reason: '隔离验证通过', stepId: step.id, executionId, bindingId: binding.id, bindingRevision: binding.bindingRevision,
      targetStatus: 'completed', evidence: [proof], checks: step.conditions.map(c => ({ ...c, result: 'passed', evidenceIds: [proof.evidenceId] })),
      blocker: null, reopen: null, successorImpact: null,
    },
  });
  assert.equal(completion.structuredContent?.status, 'accepted', JSON.stringify(completion.structuredContent));
  await writeFile(path.join(root, 'finish-turn'), '');
  const finished = await until(async () => {
    const run = (await latest()).lightContinuous.runs[0];
    if (run.status === 'blocked') throw Error(run.reason);
    return run.status === 'completed' && run;
  }, 'original run completes').catch(async error => {
    const run = (await latest()).lightContinuous.runs[0];
    const trace = await logs();
    throw Error(`${error.message}: ${run.status} / ${run.phase} / ${run.reason}; last event: ${trace.at(-1)?.event}`);
  });
  assert.equal(finished.id, checkpoint.id);
  assert.deepEqual(finished.history.map(item => [item.threadId, item.turnId, item.turnStatus]), [[threadId, turnId, 'completed']]);
  const trace = await logs();
  assert.equal(new Set(trace.map(row => row.pid)).size, 1);
  assert.deepEqual(trace.filter(row => row.event !== 'progress').map(row => row.event), ['thread/start', 'turn/start', 'turn/completed']);
  await until(async () => !await readRuntimeJson(workerFile), 'normal completion releases its worker');
  await stopService(data);
  assert.equal(await readRuntimeJson(path.join(privateDirectory, 'upgrade.json')), null);
  const restarted = await startService(data);
  assert.equal(restarted.runtimeId, newRelease);
  await stopService(data);
});
