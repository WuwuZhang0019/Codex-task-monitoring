// Date: 2026-11-12. Sample rendered frames to catch abrupt clock mounting and removal.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const root = process.env.ISLAND_SHELL_ROOT;
if (!root) throw Error('Set ISLAND_SHELL_ROOT to the shell checkout.');
const output = path.resolve(process.env.ISLAND_CLOCK_OUTPUT || 'test-results/clock-fade/browser');
const bun = process.env.ISLAND_BUN || path.resolve('test-results/island-A-tools/node_modules/bun/bin/bun.exe');
const port = Number(process.env.ISLAND_CLOCK_PORT || 1464);
const base = `http://localhost:${port}`;
const server = spawn(bun, ['node_modules/vite/bin/vite.js', '--port', String(port), '--strictPort'], { cwd: root, windowsHide: true, stdio: 'pipe' });
const logs = [];
server.stdout.on('data', value => logs.push(String(value)));
server.stderr.on('data', value => logs.push(String(value)));
const report = { date: '2026-11-12', native: false, checks: [], failures: [], pageErrors: [] };
await mkdir(output, { recursive: true });
let browser;
const check = async (name, task) => {
  try { report.checks.push({ name, passed: true, details: await task() }); }
  catch (error) { report.failures.push({ name, error: error.stack || String(error) }); }
};
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw Error(`Vite exited: ${logs.join('')}`);
    try { ready = (await fetch(base)).ok; } catch { /* Wait for startup. */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Vite must start');
  browser = await chromium.launch({ executablePath: process.env.ISLAND_BROWSER_EXE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 820 }, locale: 'zh-CN' });
  const page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.goto(base);
  await page.evaluate(() => localStorage.setItem('island-workbench-settings-v1', JSON.stringify({ 'shell.configVersion': 1, 'app.language': 'zh-CN', 'island.openOn': 'click', 'appearance.idleClock': true })));
  await page.goto(`${base}/?workbench=simulation`);
  await page.locator('[data-workbench-summary]').waitFor();
  const setting = (key, value) => page.evaluate(async ({ key, value }) => (await import('/src/core/settings.ts')).setSetting(key, value), { key, value });
  const sample = changes => page.evaluate(async changes => {
    const { setSetting } = await import('/src/core/settings.ts');
    const route = document.querySelector('[data-workbench-summary]');
    const start = performance.now();
    const frames = [];
    for (const [delay, enabled] of changes) setTimeout(() => setSetting('appearance.idleClock', enabled), delay);
    return new Promise(resolve => {
      const tick = () => {
        const summary = document.querySelector('[data-workbench-summary]');
        const clock = summary?.previousElementSibling;
        const style = clock ? getComputedStyle(clock) : null;
        frames.push({ ms: performance.now() - start, exists: !!clock, opacity: style ? Number(style.opacity) : null, blur: style?.filter, clockWidth: clock?.getBoundingClientRect().width ?? 0, routeX: summary?.getBoundingClientRect().x, sameRoute: summary === route, dots: summary?.querySelectorAll('.wb-mini-stop').length });
        if (performance.now() - start < 700 + changes.at(-1)[0]) requestAnimationFrame(tick);
        else resolve(frames);
      };
      requestAnimationFrame(tick);
    });
  }, changes);

  for (const style of ['windows', 'dynamic']) {
    await setting('appearance.style', style);
    await setting('appearance.idleClock', true);
    await page.waitForTimeout(700);
    await check(`${style}: clock fades out before it leaves the DOM`, async () => {
      const frames = await sample([[0, false]]);
      assert.ok(frames.some(frame => frame.exists && frame.opacity > 0.01 && frame.opacity < 0.99), 'Exit must have intermediate opacity');
      assert.equal(frames.at(-1).exists, false);
      assert.ok(frames.every(frame => frame.sameRoute && frame.dots === 3));
      return frames;
    });
    await check(`${style}: clock fades in while its space grows smoothly`, async () => {
      const frames = await sample([[0, true]]);
      assert.ok(frames.some(frame => frame.exists && frame.opacity > 0.01 && frame.opacity < 0.99), 'Enter must have intermediate opacity');
      assert.ok(frames.some(frame => frame.clockWidth > 1 && frame.clockWidth < frames.at(-1).clockWidth - 1), 'Clock space must animate');
      assert.equal(frames.at(-1).opacity, 1);
      assert.ok(frames.every(frame => frame.sameRoute && frame.dots === 3));
      return frames;
    });
    await check(`${style}: rapid reversal finishes on without duplicate clocks`, async () => {
      const frames = await sample([[0, false], [60, true], [110, false], [150, true]]);
      assert.equal(frames.at(-1).opacity, 1);
      assert.equal(await page.locator('[data-workbench-summary]').evaluate(element => element.parentElement.children.length), 2);
      assert.ok(frames.every(frame => frame.sameRoute && frame.dots === 3));
      return frames;
    });
  }
  await context.close();
} catch (error) {
  report.failures.push({ name: 'test setup or execution', error: error.stack || String(error) });
} finally {
  await browser?.close();
  server.kill();
  report.passed = report.failures.length === 0 && report.pageErrors.length === 0;
  await writeFile(path.join(output, 'motion.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ...report, checks: report.checks.map(check => ({ name: check.name, passed: check.passed, frames: check.details.length })) }, null, 2));
}
if (!report.passed) process.exitCode = 1;
