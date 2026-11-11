// 日期：2026-11-11。F-R01 连续轮廓、锚点与自动收起的浏览器定向检查；不代替原生区域/系统 DPI 验收。
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm, copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { createServer, HttpError } from '../server/index.mjs';
import { prepareLightPlan } from '../server/light-import.mjs';

const output = path.resolve('test-results/manual-trial/F-R01');
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(output, 'motion-http-'));
const checks = [], errors = [], contexts = [], videos = [];
const record = { date: '2026-11-11', environment: 'Edge 浏览器、真实隔离持久快照；无原生 IPC，deviceScaleFactor 不等同系统 DPI', checks, errors, limits: [] };
record.sourceIdentity = Object.fromEntries(await Promise.all(['src/useIslandMotion.ts', 'src/LightPanel.tsx', 'dist/index.html'].map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
let server, browser, page;
const text = '# F-R01 动效隔离方案\n日期：2026-11-11\n## 实施路线与出口\n| 阶段 | 前置 | 范围 | 出口 |\n| A 准备 | 用户已确认 | 数据准备 | 持久快照完整 |\n| B 面板 | A | 连续轮廓 | 顶部锚点稳定且自动收起 |\n';
const sourceFile = path.join(root, 'source.md');
await writeFile(sourceFile, text, 'utf8');

async function check(name, operation) {
  try { const details = await operation(); checks.push({ name, result: 'passed', ...(details ? { details } : {}) }); console.log(`PASS ${name}`); }
  catch (error) { checks.push({ name, result: 'failed', error: String(error.stack || error) }); throw error; }
}
const state = (p, target) => p.waitForFunction(value => document.querySelector('.lp-island')?.dataset.motion === value, target, { timeout: 5000 });
async function moveInside(p) {
  const rect = await p.locator('.lp-compact').boundingBox();
  assert.ok(rect);
  await p.mouse.move(rect.x + rect.width / 2, rect.y + 18);
}
async function moveOutside(p) { const viewport = p.viewportSize(); await p.mouse.move(2, viewport.height - 2); }
async function open(p) { await moveInside(p); await state(p, 'expanded'); }
async function close(p) { await moveOutside(p); await state(p, 'compact'); }
async function geometry(p) {
  return p.evaluate(() => {
    const island = document.querySelector('.lp-island'), compact = document.querySelector('.lp-compact');
    const rect = element => { const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height }; };
    const css = getComputedStyle(island), panel = getComputedStyle(document.querySelector('.lp-panel'));
    return { island: rect(island), compact: rect(compact), brand: rect(document.querySelector('.lp-brand')), mini: rect(document.querySelector('.lp-mini')),
      progress: Number(island.dataset.progress), motion: island.dataset.motion,
      shapeWidth: parseFloat(css.getPropertyValue('--lp-shape-width')), shapeHeight: parseFloat(css.getPropertyValue('--lp-shape-height')),
      panelBorder: [panel.borderTopWidth, panel.borderRightWidth, panel.borderBottomWidth, panel.borderLeftWidth], panelRadius: panel.borderRadius,
      panelBackground: panel.backgroundColor, bodyBackground: getComputedStyle(document.body).backgroundColor,
      htmlBackground: getComputedStyle(document.documentElement).backgroundColor,
      documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth, viewportHeight: innerHeight, dpr: devicePixelRatio };
  });
}
const monitorScript = () => {
  window.__islandFrames = [];
  const sample = now => {
    const node = document.querySelector('.lp-island'), compact = document.querySelector('.lp-compact');
    if (node?.dataset.progress && compact) {
      const s = getComputedStyle(node), a = node.getBoundingClientRect(), b = compact.getBoundingClientRect();
      window.__islandFrames.push({ time: now, progress: Number(node.dataset.progress), motion: node.dataset.motion,
        width: parseFloat(s.getPropertyValue('--lp-shape-width')), height: parseFloat(s.getPropertyValue('--lp-shape-height')),
        hostX: a.x, hostY: a.y, hostWidth: a.width, hostHeight: a.height, compactX: b.x, compactY: b.y, compactWidth: b.width, compactHeight: b.height });
      if (window.__islandFrames.length > 8000) window.__islandFrames.shift();
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
};

async function makePage(options = {}, video = false) {
  let context;
  const common = { viewport: { width: 1280, height: 800 }, extraHTTPHeaders: { Authorization: 'Bearer F-R01-test-owner' }, ...options };
  try { context = await browser.newContext({ ...common, ...(video ? { recordVideo: { dir: path.join(output, 'browser-video'), size: { width: 1280, height: 800 } } } : {}) }); }
  catch (error) {
    if (!video) throw error;
    record.limits.push(`浏览器录像创建失败，保留采样与截图：${String(error)}`);
    context = await browser.newContext(common);
  }
  let p;
  try { p = await context.newPage(); }
  catch (error) {
    if (!video) throw error;
    record.limits.push(`浏览器录像执行组件不可用，保留逐帧采样与截图：${String(error)}`);
    await context.close(); context = await browser.newContext(common); p = await context.newPage();
  }
  contexts.push(context);
  if (p.video()) videos.push(p.video());
  p.on('pageerror', error => errors.push(error.message));
  await p.addInitScript(monitorScript);
  await p.goto(`http://127.0.0.1:${server.address().port}/?view=light-live&floating=1`);
  await p.waitForFunction(() => document.querySelector('.lp-island')?.dataset.motion === 'compact' && document.querySelectorAll('.lp-station').length === 2);
  await moveOutside(p);
  return p;
}

try {
  server = await createServer({ dataDir: path.join(root, 'data'), env: {}, lightAccessEnabled: true, lightAuthorize: () => true,
    authorize(req) { if (req.headers.authorization !== 'Bearer F-R01-test-owner') throw new HttpError(403, 'FORBIDDEN'); } });
  const snapshot = prepareLightPlan({ text, sourcePath: sourceFile, version: 'F-R01-motion-fixture', projectKey: 'F-R01/project', planKey: 'F-R01/plan', name: 'F-R01 动效隔离项目', date: '2026-11-11',
    context: { sessionGroup: 'F', threadId: 'F-R01-browser-fixture', hostId: 'local', folderId: null, worktreeOrdinal: 1, worktreePath: root, branch: 'fixture', head: null, trust: 'declared' } });
  await server.workbench.light.register('fixture', { eventId: 'F-R01/register', expectedRevision: 0, snapshot });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
  record.browserVersion = browser.version();
  page = await makePage({}, true);

  await check('continuous opening and closing expose intermediate geometry in one fixed host', async () => {
    const initial = await geometry(page);
    await page.screenshot({ path: path.join(output, 'motion-compact.png') });
    await moveInside(page);
    await page.waitForFunction(() => { const n = document.querySelector('.lp-island'); return n?.dataset.motion === 'opening' && Number(n.dataset.progress) > .02 && Number(n.dataset.progress) < .97; });
    const opening = await geometry(page);
    await page.screenshot({ path: path.join(output, 'motion-opening.png') });
    await state(page, 'expanded');
    const expanded = await geometry(page);
    await page.screenshot({ path: path.join(output, 'motion-expanded.png') });
    await moveOutside(page);
    await page.waitForFunction(() => { const n = document.querySelector('.lp-island'); return n?.dataset.motion === 'closing' && Number(n.dataset.progress) > .02 && Number(n.dataset.progress) < .97; });
    const closing = await geometry(page);
    await page.screenshot({ path: path.join(output, 'motion-closing.png') });
    await state(page, 'compact');
    const compact = await geometry(page), frames = await page.evaluate(() => window.__islandFrames);
    assert.ok(opening.shapeHeight > 38 && opening.shapeHeight < expanded.shapeHeight);
    assert.ok(closing.shapeHeight > 38 && closing.shapeHeight < expanded.shapeHeight);
    assert.ok(frames.some(f => f.motion === 'opening' && f.progress > 0 && f.progress < 1));
    assert.ok(frames.some(f => f.motion === 'closing' && f.progress > 0 && f.progress < 1));
    for (const value of [opening, expanded, closing, compact]) assert.deepEqual(value.island, initial.island);
    assert.equal(compact.shapeWidth, 600); assert.equal(compact.shapeHeight, 38);
    assert.equal(initial.compact.y, 0);
    return { initial, opening, expanded, closing, compact };
  });

  await check('a single joined island outline has transparent exterior and no separate panel frame', async () => {
    await open(page); const value = await geometry(page);
    assert.deepEqual(value.panelBorder, ['0px', '0px', '0px', '0px']); assert.equal(value.panelRadius, '0px');
    assert.equal(value.panelBackground, 'rgba(0, 0, 0, 0)'); assert.equal(value.bodyBackground, 'rgba(0, 0, 0, 0)');
    assert.equal(value.htmlBackground, 'rgba(0, 0, 0, 0)');
    const join = await page.evaluate(() => {
      const a = document.querySelector('.lp-compact').getBoundingClientRect(), b = document.querySelector('.lp-panel').getBoundingClientRect();
      return { gap: b.top - a.bottom, background: getComputedStyle(document.querySelector('.lp-island'), '::before').backgroundColor };
    });
    assert.ok(Math.abs(join.gap) <= 1); assert.equal(join.background, 'rgb(20, 20, 22)');
    await close(page); return { ...value, join };
  });

  await check('twenty complete cycles preserve compact text and miniature route anchors within one CSS pixel', async () => {
    const before = await geometry(page), cycles = [];
    for (let index = 0; index < 20; index++) {
      await open(page); const expanded = await geometry(page);
      await close(page); const compact = await geometry(page);
      for (const value of [expanded, compact]) for (const key of ['brand', 'mini']) for (const axis of ['x', 'y']) {
        assert.ok(Math.abs(value[key][axis] - before[key][axis]) <= 1, `${key}.${axis} drift at cycle ${index + 1}`);
      }
      cycles.push({ expanded: expanded.compact, compact: compact.compact });
    }
    return { cycles: cycles.length, initial: before, positions: cycles, units: 'CSS pixels; native physical anchor evidence recorded separately' };
  });

  await check('default hover auto-closes but crossing into its content cancels the pending close', async () => {
    await open(page);
    await moveOutside(page); await page.waitForTimeout(180);
    const host = await page.locator('.lp-island').boundingBox();
    await page.mouse.move(host.x + host.width / 2, 120); await page.waitForTimeout(450);
    assert.equal(await page.locator('.lp-compact').getAttribute('aria-expanded'), 'true');
    await close(page);
  });

  await check('click pin holds open outside and unpin returns to the normal leave rule', async () => {
    await page.locator('.lp-compact').click(); await state(page, 'expanded');
    assert.equal(await page.getByRole('button', { name: '已固定', exact: true }).getAttribute('aria-pressed'), 'true');
    await moveOutside(page); await page.waitForTimeout(700); assert.equal(await page.locator('.lp-compact').getAttribute('aria-expanded'), 'true');
    await page.getByRole('button', { name: '已固定', exact: true }).click(); await close(page);
  });

  await check('reading details holds preview and closing details while outside restores automatic collapse', async () => {
    await open(page); await page.locator('.lp-station').first().click();
    await moveOutside(page); await page.waitForTimeout(700);
    assert.equal(await page.locator('.lp-detail').count(), 1); assert.equal(await page.locator('.lp-compact').getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Escape'); await state(page, 'compact');
    assert.equal(await page.locator('.lp-detail').count(), 0);
  });

  await check('rapid enter leave and reversal continue from intermediate geometry without stale final callbacks', async () => {
    const results = [];
    for (const delay of [50, 100, 200, 350]) {
      await open(page); await moveOutside(page); await page.waitForTimeout(delay); await moveInside(page); await state(page, 'expanded');
      // 悬停不抢键盘焦点；用真实移出触发收起，不向下方应用拥有的焦点发送 Escape。
      await moveOutside(page);
      await page.waitForFunction(() => { const n = document.querySelector('.lp-island'); return n?.dataset.motion === 'closing' && Number(n.dataset.progress) > .05 && Number(n.dataset.progress) < .95; });
      const before = await geometry(page);
      await moveOutside(page); await moveInside(page); await state(page, 'expanded');
      await page.waitForTimeout(400); const after = await geometry(page);
      assert.equal(after.progress, 1); assert.equal(await page.locator('.lp-compact').getAttribute('aria-expanded'), 'true');
      await close(page); results.push({ delay, reversalFrom: before.progress, final: after.progress });
    }
    return results;
  });

  await check('reduced motion keeps the same end states without content translation', async () => {
    const reduced = await makePage({ reducedMotion: 'reduce' }); await open(reduced);
    assert.equal(await reduced.locator('.lp-panel').evaluate(n => getComputedStyle(n).transform), 'none');
    const final = await geometry(reduced); assert.equal(final.progress, 1); await close(reduced);
    await reduced.screenshot({ path: path.join(output, 'motion-reduced-compact.png') });
    return final;
  });

  await check('small viewport and browser scale factors keep the fixed top anchor and reachable controls', async () => {
    const variants = [];
    for (const option of [{ width: 390, height: 740, scale: 1 }, { width: 1280, height: 800, scale: 1.25 }, { width: 1280, height: 800, scale: 1.5 }, { width: 1280, height: 800, scale: 2 }]) {
      const p = await makePage({ viewport: { width: option.width, height: option.height }, deviceScaleFactor: option.scale });
      await open(p); const value = await geometry(p);
      assert.equal(value.compact.y, 0); assert.ok(value.documentWidth <= option.width);
      assert.ok(value.island.x >= 0 && value.island.x + value.island.width <= option.width + 1);
      assert.ok(value.island.height <= option.height);
      const collapse = await p.getByRole('button', { name: '收起', exact: true }).boundingBox();
      assert.ok(collapse && collapse.y >= 0 && collapse.y + collapse.height <= option.height);
      await p.screenshot({ path: path.join(output, `browser-scale-${Math.round(option.scale * 100)}-${option.width}.png`) });
      await p.getByRole('button', { name: '收起', exact: true }).click(); await state(p, 'compact');
      variants.push({ ...option, geometry: value });
    }
    return { note: 'Browser deviceScaleFactor only; no claim of native Windows DPI changes', variants };
  });
  assert.deepEqual(errors, []);
  assert.equal(createHash('sha256').update(await readFile('dist/index.html')).digest('hex'), record.sourceIdentity['dist/index.html'], 'dist changed during the motion run');
  record.frames = await page.evaluate(() => window.__islandFrames);
  record.result = 'passed';
} catch (error) {
  record.result = 'failed'; record.failure = String(error.stack || error);
  if (page) {
    try { record.failureGeometry = await geometry(page); record.frames = await page.evaluate(() => window.__islandFrames); await page.screenshot({ path: path.join(output, 'motion-failure.png') }); } catch {}
  }
  throw error;
} finally {
  for (const context of contexts) await context.close();
  if (videos.length) {
    try { await copyFile(await videos.at(-1).path(), path.join(output, 'island-motion-browser.webm')); record.browserVideo = path.join(output, 'island-motion-browser.webm'); }
    catch (error) { record.limits.push(`浏览器录像保存失败：${String(error)}`); }
  }
  await browser?.close();
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await writeFile(path.join(output, 'island-motion-result.json'), JSON.stringify(record, null, 2) + '\n', 'utf8');
  assert.ok(root.startsWith(output + path.sep) && path.basename(root).startsWith('motion-http-'));
  await rm(root, { recursive: true, force: true });
}
