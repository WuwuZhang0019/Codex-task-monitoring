// 日期：2026-11-11。F-R01 动画中 resize 与 IPC 生命周期定向检查；native invoke 部分为受控替身，不是原生证据。
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { createServer, HttpError } from '../server/index.mjs';
import { prepareLightPlan } from '../server/light-import.mjs';

const output = path.resolve('test-results/manual-trial/F-R01');
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(output, 'ipc-http-'));
const record = { date: '2026-11-11', environment: 'Edge 浏览器与真实隔离持久读取；panel_window/panel_frame/panel_pin 使用可延迟、失败及拒绝旧序号的 invoke 替身，无 Win32 操作', checks: [], fixtures: [], errors: [], limits: ['生产 dist 不执行 React 开发模式的双 effect；以在途旧帧跨页面重载检验重挂隔离，不宣称原生 StrictMode/系统 DPI 实测'] };
record.sourceIdentity = Object.fromEntries(await Promise.all(['src/useIslandMotion.ts', 'src/LightPanel.tsx', 'dist/index.html'].map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
const contexts = [], pending = new Set();
let browser, server;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function check(name, fn) {
  try { const details = await fn(); record.checks.push({ name, result: 'passed', ...(details ? { details } : {}) }); console.log(`PASS ${name}`); }
  catch (error) { record.checks.push({ name, result: 'failed', error: String(error.stack || error) }); throw error; }
}
function fixture(name, options = {}) {
  const value = { name, progress: 0, lastFrame: 0, active: 0, peak: 0, activeFrames: 0, peakFrames: 0, activeConfigs: 0, peakConfigs: 0,
    configureDelay: 20, frameDelay: 15, failFrames: 0, failConfigs: 0, persistentFrameFailure: false, persistentConfigFailure: false,
    lateNextFrame: false, lateDelay: 800, staleRejected: 0, calls: [], generations: {}, ...options };
  record.fixtures.push(value); return value;
}
async function waitNative(fn, label, timeout = 5000) {
  const start = Date.now();
  while (!fn()) { if (Date.now() - start > timeout) throw Error(`Timed out waiting for ${label}`); await sleep(10); }
}
const state = (page, target) => page.waitForFunction(value => document.querySelector('.lp-island')?.dataset.motion === value, target, { timeout: 6000 });
async function inside(page) { const r = await page.locator('.lp-compact').boundingBox(); await page.mouse.move(r.x + r.width / 2, 18); }
async function outside(page) { await page.mouse.move(2, page.viewportSize().height - 2); }
async function geometry(page) {
  return page.locator('.lp-island').evaluate(node => {
    const css = getComputedStyle(node), r = node.getBoundingClientRect();
    return { progress: Number(node.dataset.progress), motion: node.dataset.motion, width: r.width, height: r.height, x: r.x, y: r.y,
      shapeWidth: parseFloat(css.getPropertyValue('--lp-shape-width')), shapeHeight: parseFloat(css.getPropertyValue('--lp-shape-height')) };
  });
}

function invoke(f, command, args) {
  if (command === 'panel_pin' || command === 'panel_show_main') return Promise.resolve({ pinned: args.pinned, progress: f.progress });
  if (!['panel_window', 'panel_frame'].includes(command)) throw Error(`Unsupported fixture command ${command}`);
  const generation = args.__testGeneration;
  f.generations[generation] ??= { active: 0, peak: 0 };
  const g = f.generations[generation];
  const entry = { command, generation, frame: args.frame ?? null, requestedProgress: args.progress ?? null, startedAt: Date.now() };
  f.calls.push(entry); f.active++; g.active++; f.peak = Math.max(f.peak, f.active); g.peak = Math.max(g.peak, g.active);
  if (command === 'panel_frame') { f.activeFrames++; f.peakFrames = Math.max(f.peakFrames, f.activeFrames); }
  else { f.activeConfigs++; f.peakConfigs = Math.max(f.peakConfigs, f.activeConfigs); }
  const viewport = args.__testViewport;
  const delay = command === 'panel_window' ? f.configureDelay : f.lateNextFrame ? (f.lateNextFrame = false, entry.late = true, f.lateDelay) : f.frameDelay;
  const work = (async () => {
    try {
      await sleep(delay);
      if (command === 'panel_window') {
        if (f.persistentConfigFailure || f.failConfigs > 0) { if (f.failConfigs) f.failConfigs--; throw Error('FIXTURE_CONFIG_FAILURE'); }
        entry.result = { width: Math.max(1, Math.min(960, viewport.width - 32)), height: Math.max(38, Math.min(678, viewport.height - 16)), compactWidth: Math.min(600, Math.max(1, viewport.width - 32)), progress: f.progress };
      } else {
        if (f.persistentFrameFailure || f.failFrames > 0) { if (f.failFrames) f.failFrames--; throw Error('FIXTURE_FRAME_FAILURE'); }
        if (args.frame <= f.lastFrame) { f.staleRejected++; entry.result = { applied: false, progress: f.progress, frame: f.lastFrame }; }
        else { f.lastFrame = args.frame; f.progress = args.progress; entry.result = { applied: true, progress: f.progress, frame: f.lastFrame }; }
      }
      return entry.result;
    } catch (error) { entry.error = String(error); throw error; }
    finally {
      entry.endedAt = Date.now(); f.active--; g.active--;
      if (command === 'panel_frame') f.activeFrames--; else f.activeConfigs--;
    }
  })();
  pending.add(work); work.then(() => pending.delete(work), () => pending.delete(work)); return work;
}

async function makePage(f = null, ready = true) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, extraHTTPHeaders: { Authorization: 'Bearer F-R01-ipc-owner' } });
  contexts.push(context);
  if (f) {
    await context.exposeBinding('__islandNativeFixture', (_source, command, args) => invoke(f, command, args));
    await context.addInitScript(() => {
      const generation = crypto.randomUUID();
      window.__TAURI__ = { core: { invoke: async (command, args = {}) => {
        if (command === 'api_request') {
          const response = await fetch(`/api${args.path}`, { method: args.method, headers: args.body ? { 'Content-Type': 'application/json' } : undefined, body: args.body ? JSON.stringify(args.body) : undefined });
          return { status: response.status, data: await response.json() };
        }
        return window.__islandNativeFixture(command, { ...args, __testGeneration: generation, __testViewport: { width: innerWidth, height: innerHeight } });
      } } };
    });
  }
  const page = await context.newPage(); page.on('pageerror', e => record.errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?view=light-live&floating=1`);
  await page.locator('.lp-compact').waitFor(); await outside(page);
  if (ready) await state(page, 'compact');
  return page;
}

try {
  const text = '# F-R01 IPC隔离方案\n日期：2026-11-11\n## 实施路线与出口\n| 阶段 | 前置 | 范围 | 出口 |\n| A 准备 | 用户已确认 | 数据 | 持久完整 |\n| B 展示 | A | 动效 | 连续形变 |\n';
  const sourcePath = path.join(root, 'source.md'); await writeFile(sourcePath, text, 'utf8');
  server = await createServer({ dataDir: path.join(root, 'data'), env: {}, lightAccessEnabled: true, lightAuthorize: () => true,
    authorize(req) { if (req.headers.authorization !== 'Bearer F-R01-ipc-owner') throw new HttpError(403, 'FORBIDDEN'); } });
  const snapshot = prepareLightPlan({ text, sourcePath, version: 'F-R01-ipc-fixture', projectKey: 'ipc/project', planKey: 'ipc/plan', name: 'F-R01 IPC隔离项目', date: '2026-11-11',
    context: { sessionGroup: 'F', threadId: 'F-R01-ipc-fixture', hostId: 'local', folderId: null, worktreeOrdinal: 1, worktreePath: root, branch: 'fixture', head: null, trust: 'declared' } });
  await server.workbench.light.register('fixture', { eventId: 'F-R01/ipc-register', expectedRevision: 0, snapshot });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
  record.browserVersion = browser.version();

  await check('real browser resize during opening is retained and applies the latest bounds before final state', async () => {
    const page = await makePage();
    await inside(page); await page.waitForFunction(() => { const n = document.querySelector('.lp-island'); return Number(n?.dataset.progress) > .01 && Number(n?.dataset.progress) < .8; });
    const before = await geometry(page);
    await page.setViewportSize({ width: 640, height: 500 }); await inside(page); await state(page, 'expanded');
    const after = await geometry(page);
    assert.equal(after.width, 608); assert.equal(after.height, 484); assert.equal(after.shapeWidth, 608); assert.equal(after.shapeHeight, 484); assert.equal(after.y, 0);
    await page.screenshot({ path: path.join(output, 'motion-resize-during-opening.png') });
    await outside(page); await state(page, 'compact');
    return { before, after, kind: 'real browser viewport resize, no native substitution' };
  });

  await check('delayed configure and frame acknowledgements remain serialized when the target changes', async () => {
    const f = fixture('delayed-config-frame', { configureDelay: 80, frameDelay: 160 });
    const page = await makePage(f, false);
    await waitNative(() => f.activeFrames === 1, 'initial configuration frame');
    await page.locator('.lp-compact').click(); await state(page, 'expanded');
    await page.setViewportSize({ width: 700, height: 550 }); await inside(page);
    await page.waitForFunction(() => parseFloat(getComputedStyle(document.querySelector('.lp-island')).getPropertyValue('--lp-host-width')) === 668);
    await waitNative(() => f.active === 0, 'transport drain');
    assert.equal(f.peak, 1); assert.equal(f.peakFrames, 1); assert.equal(f.peakConfigs, 1);
    assert.ok(Object.values(f.generations).every(g => g.peak === 1)); assert.equal(f.progress, 1);
    return { peak: f.peak, peakFrames: f.peakFrames, peakConfigs: f.peakConfigs, final: await geometry(page), kind: 'controlled invoke substitute' };
  });

  await check('one rejected frame resynchronizes the acknowledged progress and reaches the requested endpoint', async () => {
    const f = fixture('one-frame-failure'); const page = await makePage(f); const baseline = f.calls.length;
    f.failFrames = 1;
    await page.locator('.lp-compact').focus(); await page.keyboard.press('Enter'); await state(page, 'expanded');
    await waitNative(() => f.active === 0, 'recovered frame drain');
    const calls = f.calls.slice(baseline);
    assert.equal(calls.filter(c => c.error).length, 1); assert.ok(calls.some(c => c.command === 'panel_window'));
    assert.equal(f.progress, 1); assert.equal((await geometry(page)).progress, 1); assert.equal(f.peak, 1);
    return { errorCalls: calls.filter(c => c.error).length, configureRecoveryCalls: calls.filter(c => c.command === 'panel_window').length, final: await geometry(page) };
  });

  await check('one initialization failure retries once and does not strand the compact controller', async () => {
    const f = fixture('one-configure-failure', { failConfigs: 1 }); const page = await makePage(f);
    assert.equal(f.calls.filter(c => c.error).length, 1);
    await page.locator('.lp-compact').focus(); await page.keyboard.press('Enter'); await state(page, 'expanded');
    assert.equal(f.progress, 1); assert.equal(f.peak, 1);
    return { configureCalls: f.calls.filter(c => c.command === 'panel_window').length, final: await geometry(page) };
  });

  await check('persistent frame failure stops after one bounded recovery and a later explicit click can retry', async () => {
    const f = fixture('persistent-frame-failure'); const page = await makePage(f); const baseline = f.calls.length;
    f.persistentFrameFailure = true;
    await page.locator('.lp-compact').focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.lp-event')?.textContent.includes('动效同步失败'));
    await waitNative(() => f.active === 0, 'persistent failure stop'); await sleep(500);
    const stoppedCount = f.calls.length, failures = f.calls.slice(baseline).filter(c => c.error).length;
    assert.equal(failures, 2); await sleep(400); assert.equal(f.calls.length, stoppedCount);
    assert.equal(f.progress, (await geometry(page)).progress); assert.equal(f.peak, 1);
    f.persistentFrameFailure = false; await inside(page); await page.locator('.lp-compact').press('Enter'); await state(page, 'expanded');
    assert.equal(f.progress, 1);
    await page.waitForFunction(() => document.querySelector('.lp-event')?.textContent.includes('动效同步已恢复'));
    assert.ok(!(await page.locator('.lp-event').textContent()).includes('动效同步失败'));
    return { failuresBeforeStop: failures, stoppedCount, recoveredFinal: await geometry(page), diagnosticAfterRecovery: await page.locator('.lp-event').textContent() };
  });

  await check('an in-flight frame from a discarded page cannot overwrite newer remount frames', async () => {
    const f = fixture('remount-stale-frame', { configureDelay: 10, frameDelay: 15, lateDelay: 800 });
    const page = await makePage(f); const before = f.lastFrame;
    f.lateNextFrame = true;
    await page.locator('.lp-compact').focus(); await page.keyboard.press('Enter');
    await waitNative(() => f.calls.some(c => c.late && !c.endedAt), 'late opening frame');
    await page.reload(); await page.locator('.lp-compact').waitFor(); await outside(page); await state(page, 'compact');
    await waitNative(() => f.active === 0, 'discarded old frame drain');
    assert.ok(f.lastFrame > before); assert.ok(f.staleRejected >= 1); assert.equal(f.progress, 0); assert.equal((await geometry(page)).progress, 0);
    assert.ok(f.peak <= 2); assert.ok(Object.values(f.generations).every(g => g.peak <= 1));
    return { generations: f.generations, staleRejected: f.staleRejected, peakAcrossOldAndCurrentGeneration: f.peak, final: await geometry(page), kind: 'page remount plus controlled delayed native substitute, not React development StrictMode execution' };
  });
  assert.deepEqual(record.errors, []);
  assert.equal(createHash('sha256').update(await readFile('dist/index.html')).digest('hex'), record.sourceIdentity['dist/index.html'], 'dist changed during the IPC run');
  record.result = 'passed';
} catch (error) { record.result = 'failed'; record.failure = String(error.stack || error); throw error; }
finally {
  for (const context of contexts) await context.close();
  await Promise.allSettled([...pending]); await browser?.close();
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await writeFile(path.join(output, 'island-ipc-result.json'), JSON.stringify(record, null, 2) + '\n', 'utf8');
  assert.ok(root.startsWith(output + path.sep) && path.basename(root).startsWith('ipc-http-')); await rm(root, { recursive: true, force: true });
}
