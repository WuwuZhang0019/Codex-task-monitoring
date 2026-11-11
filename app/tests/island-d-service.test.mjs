// 日期：2026-11-12。独立临时数据/Git：真实所有者与STDIO接线，不写正式项目。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { prepareLightPlan } from '../server/light-import.mjs';
import { startService, stopService } from '../desktop/service.mjs';
import { connectOwner, discoverOwner } from '../desktop/client.mjs';

test('island D standalone→STDIO update→scoped panel, preferences and generation recovery', { timeout: 90000 }, async t => {
  let root;
  let keepSuccessfulRoot = false;
  if (process.env.ISLAND_D_KEEP_NATIVE_ROOT) {
    const base = path.resolve(fileURLToPath(new URL('../test-results/island-D', import.meta.url)));
    root = path.resolve(process.env.ISLAND_D_KEEP_NATIVE_ROOT);
    if (path.dirname(root) !== base || !path.basename(root).startsWith('native-')) throw Error('KEEP_NATIVE_ROOT_OUTSIDE_TEST_WORKSPACE');
    await mkdir(base, { recursive: true });
    await mkdir(root, { recursive: true });
    if ((await readdir(root)).length || path.dirname(await realpath(root)) !== await realpath(base)) throw Error('KEEP_NATIVE_ROOT_MUST_BE_EMPTY');
  } else root = await mkdtemp(path.join(os.tmpdir(), 'island-d-service-'));
  const dataDir = path.join(root, 'data');
  const worktree = path.join(root, 'worktree');
  const configFile = path.join(root, 'bridge.json');
  const results = [];
  const check = (name, details = {}) => results.push({ name, result: 'passed', ...details });
  await mkdir(worktree);
  const git = args => execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim();
  git(['init', '-b', 'main']);
  git(['-c', 'user.name=Island D fixture', '-c', 'user.email=island-d@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
  const head = git(['rev-parse', 'HEAD']);
  let record, manager, panel, client;
  let diagnostics = '';
  const secrets = [];
  t.after(async () => {
    await client?.close();
    if (!keepSuccessfulRoot) {
      await stopService(dataDir).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });
  async function start() {
    record = await startService(dataDir);
    manager = await connectOwner(dataDir);
    panel = JSON.parse(await readFile(path.join(dataDir, 'runtime-private/panel-session.json'), 'utf8'));
    secrets.push(manager.token, panel.token);
    return record;
  }
  async function request(route, method = 'GET', body, token = panel.token, headers = {}) {
    return fetch(`${record.endpoint}${route}`, { method, redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  }
  async function privateCall(route, body) {
    const response = await request(`/api/light-access/${route}`, 'POST', body, manager.token);
    assert.ok(response.ok, `${route}: ${response.status} ${await response.clone().text()}`);
    return response.json();
  }
  async function panelRead() {
    const response = await request('/api/light-panel');
    assert.equal(response.status, 200);
    return response.json();
  }
  const accepted = value => { assert.equal(value.status, 'accepted', JSON.stringify(value)); return value.result; };
  const call = async (name, input) => (await client.callTool({ name, arguments: input })).structuredContent;
  await start();
  assert.equal(record.lifetime, 'standalone');
  const attached = await startService(dataDir);
  assert.equal(attached.pid, record.pid);
  assert.equal(attached.attached, true);
  check('独立所有者与重复显式启动附着同一PID', { lifetime: record.lifetime });

  const projectKey = 'island-d-integration/project';
  const planKey = 'island-d-integration/plan';
  const threadId = randomUUID(), hostId = 'local';
  const grant = await privateCall('grants', { projectKeys: [projectKey], threadId, hostId, worktreeRoots: [worktree], acknowledged: true });
  secrets.push(grant.token);
  await writeFile(configFile, JSON.stringify({ dataDir, token: grant.token }), { mode: 0o600 });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../mcp/light-stdio.mjs', import.meta.url))], env: { WORKBENCH_LIGHT_CONFIG: configFile }, stderr: 'pipe' });
  transport.stderr.on('data', chunk => { diagnostics += chunk; });
  client = new Client({ name: 'island-d-integration', version: '0.1.0' });
  await client.connect(transport, { timeout: 10000 });
  assert.equal((await client.listTools()).tools.length, 9);
  const sourcePath = path.join(root, 'source.md');
  const sourceText = '# 隔离接线方案\n日期：2026-11-12\n## 实施路线与出口\n| 阶段 | 前置 | 范围 | 出口 |\n| A 接线 | 用户已确认 | 接线 | 快照一致且偏好持久 |\n| B 恢复 | A | 恢复 | 离线后恢复保存的选择 |\n';
  await writeFile(sourcePath, sourceText);
  const context = { sessionGroup: 'D', threadId, hostId, folderId: null, worktreeOrdinal: 1, worktreePath: worktree, branch: 'main', head, trust: 'declared' };
  const candidate = prepareLightPlan({ text: sourceText, sourcePath, version: 'island-D-isolated-v1', projectKey, planKey,
    name: '灵动岛D隔离服务项目', date: '2026-11-12', context });
  const source = Object.fromEntries(Object.entries(candidate.plans[0].source).filter(([key]) => key !== 'trust'));
  const registration = { schemaVersion: 'light-1.0', expectedRevision: 0, eventId: 'island-D/register', source,
    occurredAt: '2026-11-12T00:00:00+08:00', snapshot: candidate };
  const publication = await privateCall('confirm-publication', { principal: grant.principal, operation: 'register', input: registration, acknowledged: true });
  secrets.push(publication.confirmationGrant);
  const registered = accepted(await call('workbench_register_plan', { ...registration, confirmationGrant: publication.confirmationGrant }));
  const projectId = registered.projectId, planId = registered.planIds[0];
  let snapshot;
  const read = async () => { snapshot = accepted(await call('workbench_get_project', { projectId })); return snapshot; };
  await read();
  const base = eventId => ({ schemaVersion: 'light-1.0', projectId, planId, expectedRevision: snapshot.projects[0].revision,
    eventId, source, occurredAt: '2026-11-12T00:00:00+08:00', reason: '灵动岛D独立服务隔离接线验收' });
  const step = snapshot.steps[0];
  const proposal = { ...base('island-D/propose'), action: 'propose', stepIds: [step.id], context,
    bindingId: null, expectedBindingRevision: null, confirmationGrant: null };
  const proposed = accepted(await call('workbench_bind_context', proposal));
  await read();
  const confirmation = { ...proposal, ...base('island-D/confirm'), action: 'confirm', bindingId: proposed.bindingId,
    expectedBindingRevision: proposed.bindingRevision };
  const bindingGrant = await privateCall('confirm-binding', { principal: grant.principal, input: confirmation, acknowledged: true });
  secrets.push(bindingGrant.confirmationGrant);
  const bound = accepted(await call('workbench_bind_context', { ...confirmation, confirmationGrant: bindingGrant.confirmationGrant }));
  await read();
  const reserved = accepted(await call('workbench_reserve_execution', base('island-D/reserve')));
  await read();
  const startInput = { ...base('island-D/start'), stepId: step.id, executionId: reserved.executionId,
    bindingId: bound.bindingId, bindingRevision: bound.bindingRevision, targetStatus: 'running',
    evidence: [], checks: [], blocker: null, reopen: null, successorImpact: null };
  accepted(await call('workbench_update_step_status', startInput));
  await read();
  const display = await panelRead();
  assert.deepEqual(display.snapshot, snapshot);
  assert.equal(display.snapshot.steps[0].status, 'running');
  assert.equal(display.snapshot.steps[0].id, step.id);
  assert.equal(display.capabilities.threadJump, false);
  assert.equal(display.sources[planKey], sourceText);
  check('真实STDIO登记/绑定/状态上报与最小面板完整快照一致', { revision: snapshot.revision, stepId: step.id, status: 'running' });
  const committedRevision = snapshot.revision;
  const preferences = { collapsed: [], selected: snapshot.steps[1].key, focus: [], scroll: { [planKey]: 45 }, y: { all: 99 } };
  assert.equal((await request('/api/light-panel/preferences', 'PUT', preferences)).status, 200);
  assert.deepEqual((await panelRead()).preferences, preferences);
  assert.equal((await read()).revision, committedRevision);
  check('面板偏好保存回读且不递增业务revision', { revision: committedRevision });
  for (const [route, method, body] of [
    ['/api/projects', 'GET'], ['/api/light-access/grants', 'POST', { acknowledged: true }],
    ['/api/light-mcp', 'GET'], ['/api/light-panel', 'POST', {}], ['/api/light-panel?unexpected=1', 'GET'],
  ]) assert.equal((await request(route, method, body)).status, 403, route);
  assert.equal((await request('/api/light-panel', 'GET', undefined, panel.token, { Origin: 'http://localhost' })).status, 403);
  check('面板令牌拒绝业务、签发授权、MCP、非白名单方法/查询及Origin');
  const query = { projectId, operation: 'update', eventId: startInput.eventId };
  const queried = accepted(await call('workbench_query_event', query));
  assert.equal(queried.state, 'committed');
  assert.deepEqual(accepted(await call('workbench_update_step_status', startInput)), queried.result);
  assert.equal((await read()).events.filter(event => event.toStatus === 'running').length, 1);
  const unknown = accepted(await call('workbench_query_event', { ...query, eventId: 'island-D/not-submitted' }));
  assert.equal(unknown.state, 'unknown');
  check('原scope/event查询与重放幂等，无记录保持unknown');
  const beforeRestart = structuredClone(snapshot);
  const oldGeneration = record.ownerGeneration, oldPanelToken = panel.token;
  await stopService(dataDir);
  await assert.rejects(discoverOwner(dataDir), /STOPPED/);
  assert.equal((await call('workbench_get_project', { projectId })).error.code, 'OWNER_UNAVAILABLE');
  await start();
  assert.notEqual(record.ownerGeneration, oldGeneration);
  assert.equal((await request('/api/light-panel', 'GET', undefined, oldPanelToken)).status, 403);
  assert.deepEqual((await panelRead()).preferences, preferences);
  assert.deepEqual(await read(), beforeRestart);
  assert.equal((await read()).revision, committedRevision);
  assert.deepEqual(accepted(await call('workbench_query_event', query)), queried);
  check('停止可识别、generation重发现、旧凭据拒绝、MCP原配置和偏好恢复');
  if (process.env.ISLAND_D_BROWSER_URL) {
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
    const browserContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
    const page = await browserContext.newPage();
    const errors = [];
    const moduleUrls = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => moduleUrls.push(request.url()));
    let fault = null;
    const deferredReads = [];
    let reads = 0, saves = 0;
    await page.exposeBinding('islandDNativeTestBridge', async (_source, command, args) => {
      if (command === 'island_workbench_read') {
        reads++;
        if (fault === 'deferred') await new Promise(resolve => deferredReads.push(resolve));
        if (fault === 'unauthorized') throw Error('FORBIDDEN');
        if (fault === 'offline') throw Error('OWNER_UNAVAILABLE');
        const panelValue = await panelRead();
        // Display-only long-detail variant. It never changes the service project,
        // its business state or persisted native-observation fixture.
        panelValue.snapshot.steps[1].blockers = Array.from({ length: 20 }, (_, index) => ({
          blockerId: `display-only/long-detail/${index}`, reason: `阅读恢复显示样例 ${index + 1}`,
          waitingFor: ['只用于浏览器详情长度，未写入服务'], releaseConditions: ['显示夹具无需业务解除'], resolved: false,
        }));
        panelValue.preferences = { ...panelValue.preferences,
          selected: snapshot.steps[1].key, y: { ...panelValue.preferences.y, 'island/detail': 180 } };
        if (fault === 'incompatible') panelValue.snapshot.schemaVersion = 'unsupported-test-version';
        if (fault === 'older') panelValue.snapshot.revision = 0;
        return panelValue;
      }
      if (command === 'island_workbench_save_preferences') {
        saves++;
        const response = await request('/api/light-panel/preferences', 'PUT', args.value);
        assert.equal(response.status, 200);
        return response.json();
      }
      throw Error('Unexpected browser bridge command');
    });
    try {
      // Let shell modules select their browser path. Only the workbench transport is
      // replaced after load; this is explicitly not a native IPC acceptance claim.
      await page.goto(process.env.ISLAND_D_BROWSER_URL, { waitUntil: 'networkidle' });
      const shell = page.locator('[data-hit]').first();
      await shell.click({ position: { x: 100, y: 15 } });
      await page.locator('[data-connection="offline"]').waitFor();
      assert.equal(await page.getByRole('combobox', { name: '演示场景' }).count(), 0);
      assert.equal(await page.locator('[data-project-key]').count(), 0);
      check('浏览器无原生桥首次读取明确离线且无模拟回退');
      await page.evaluate(() => {
        window.__TAURI_INTERNALS__ = { invoke: (command, args) => window.islandDNativeTestBridge(command, args) };
      });
      const refresh = async () => { await page.getByRole('button', { name: '刷新', exact: true }).click(); };
      await refresh();
      await page.locator('[data-connection="ready"]').waitFor();
      assert.match(await page.locator('[data-workbench]').innerText(), /真实服务/);
      assert.match(await page.locator('[data-workbench]').innerText(), /灵动岛D隔离服务项目/);
      assert.ok((await page.locator('[data-workbench-detail]').innerText()).includes(snapshot.steps[1].id));
      assert.equal(await page.locator('[data-step-key]').count(), 2);
      await page.waitForFunction(() => Math.abs(document.querySelector('[data-workbench-detail]').scrollTop - 180) <= 2);
      check('首次离线后重连恢复第二阶段选择及长详情阅读位置', {
        displayVariant: 'browser-only long-detail blockers + preferences y override; service business snapshot unchanged',
        expectedDetailTop: 180, actualDetailTop: await page.locator('[data-workbench-detail]').evaluate(node => node.scrollTop),
      });
      check('真实STDIO项目在新外壳service视图显示，身份和running状态一致', { native: false, transport: 'Playwright exposed binding to real scoped panel HTTP' });
      for (const connection of ['unauthorized', 'incompatible', 'offline']) {
        fault = connection;
        await refresh();
        await page.locator(`[data-connection="${connection}"]`).waitFor();
        assert.equal(await page.locator('[data-project-key]').count(), 1);
        assert.equal(await page.getByRole('combobox', { name: '演示场景' }).count(), 0);
      }
      fault = 'older';
      await refresh();
      await page.locator('[data-connection="stale"]').waitFor();
      assert.equal(await page.locator('[data-step-key]').count(), 2);
      fault = null;
      await refresh();
      await page.locator('[data-connection="ready"]').waitFor();
      check('新外壳拒绝授权/版本错误/离线及旧revision保留最后快照且可重连');
      await page.getByRole('button', { name: '定位当前', exact: true }).click();
      await page.waitForTimeout(700);
      assert.ok(saves > 0, 'reading interaction must save preferences through scoped route');
      assert.equal((await panelRead()).snapshot.revision, committedRevision);
      check('阅读交互只保存偏好且不改变业务版本', { reads, saves });
      assert.deepEqual(errors, []);
      if (process.env.D_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.D_EVIDENCE_DIR, 'island-d-service-browser.png') });
      const reactUrl = moduleUrls.find(url => /\/react\.js\?/.test(url));
      const domUrl = moduleUrls.find(url => /\/react-dom_client\.js\?/.test(url));
      assert.ok(reactUrl && domUrl, 'Vite React module URLs must be observed before mounting hook probe');
      fault = 'deferred';
      await page.evaluate(async ({ reactUrl, domUrl }) => {
        const reactModule = await import(reactUrl);
        const domModule = await import(domUrl);
        const React = reactModule.default ?? reactModule;
        const ReactDOM = domModule.default ?? domModule;
        const { useWorkbench } = await import('/src/workbench/useWorkbench.ts');
        const node = document.createElement('div');
        node.dataset.islandDHookProbe = 'true';
        document.body.append(node);
        const originalTimeout = window.setTimeout;
        window.islandDProbeSchedules = 0;
        window.setTimeout = (callback, delay, ...args) => {
          if (delay === 10000 || delay === 30000) {
            window.islandDProbeSchedules++;
            return originalTimeout(callback, 25, ...args);
          }
          return originalTimeout(callback, delay, ...args);
        };
        function Probe() {
          const state = useWorkbench();
          return React.createElement('span', null, state.envelope?.connection.state ?? 'loading');
        }
        const root = ReactDOM.createRoot(node);
        window.islandDUnmountProbe = () => root.unmount();
        window.islandDRestoreTimeout = () => { window.setTimeout = originalTimeout; node.remove(); };
        root.render(React.createElement(Probe));
      }, { reactUrl, domUrl });
      await page.waitForFunction(() => window.islandDProbeSchedules > 0);
      await page.waitForTimeout(100);
      assert.ok(deferredReads.length >= 2, 'probe initial and poll reads must both be pending');
      const schedulesAtUnmount = await page.evaluate(() => { window.islandDUnmountProbe(); return window.islandDProbeSchedules; });
      fault = null;
      for (const release of deferredReads.splice(0)) release();
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => window.islandDProbeSchedules), schedulesAtUnmount);
      await page.evaluate(() => window.islandDRestoreTimeout());
      assert.deepEqual(errors, []);
      check('同页React hook卸载后迟到poll响应不再安排轮询', { probe: 'actual useWorkbench hook; 10s/30s timer accelerated to 25ms; delayed IPC test binding' });
    } catch (error) {
      if (process.env.D_EVIDENCE_DIR) {
        await writeFile(path.join(process.env.D_EVIDENCE_DIR, 'island-d-browser-failed.json'), JSON.stringify({ date: '2026-11-12', native: false, checks: results, error: String(error.stack), errors }, null, 2));
        await page.screenshot({ path: path.join(process.env.D_EVIDENCE_DIR, 'island-d-browser-failed.png') }).catch(() => {});
      }
      throw error;
    } finally {
      await browserContext.close();
      await browser.close();
    }
  }
  for (const secret of secrets) assert.equal(diagnostics.includes(secret), false);
  check('STDIO诊断无凭据');
  if (process.env.D_EVIDENCE_DIR) {
    await mkdir(process.env.D_EVIDENCE_DIR, { recursive: true });
    const evidence = { date: '2026-11-12', native: false, formalProject: false,
      environment: '隔离临时Git及数据根，实际standalone owner子进程、STDIO MCP与受限HTTP面板',
      checks: results, snapshot, preferences, diagnostics };
    const serialized = JSON.stringify(evidence, null, 2);
    for (const secret of secrets) assert.equal(serialized.includes(secret), false);
    await writeFile(path.join(process.env.D_EVIDENCE_DIR, 'island-d-service.json'), serialized);
  }
  if (process.env.ISLAND_D_KEEP_NATIVE_ROOT) {
    keepSuccessfulRoot = true;
    const retained = { date: '2026-11-12', formalProject: false, dataDir, ownerPid: record.pid, ownerGeneration: record.ownerGeneration,
      note: 'Only isolated test state retained for native observation; private credentials stay in ignored test-results. Parent cleans up after observation.' };
    if (process.env.D_EVIDENCE_DIR) await writeFile(path.join(process.env.D_EVIDENCE_DIR, 'island-d-native-test-root.json'), JSON.stringify(retained, null, 2));
    console.log(JSON.stringify(retained));
  }
});
