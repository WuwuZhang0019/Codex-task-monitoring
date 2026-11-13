// Date: 2026-11-13. Browser evidence for source-adapted branch curves and host interactions.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const root = process.env.ISLAND_SHELL_ROOT;
if (!root && !process.env.ISLAND_BROWSER_URL) throw Error('Set ISLAND_SHELL_ROOT to the source-adaptation worktree');
const output = path.resolve(process.env.ISLAND_ROADMAP_OUTPUT || 'test-results/git-roadmap');
const base = process.env.ISLAND_BROWSER_URL || 'http://localhost:1473';
const server = process.env.ISLAND_BROWSER_URL ? null : spawn(process.env.BUN_EXECUTABLE || 'bun',
  ['node_modules/vite/bin/vite.js', 'preview', '--port', '1473', '--strictPort'],
  { cwd: root, windowsHide: true, stdio: 'pipe' });
const logs = [];
server?.on('error', error => logs.push(String(error)));
server?.stdout.on('data', chunk => logs.push(String(chunk)));
server?.stderr.on('data', chunk => logs.push(String(chunk)));
const report = { date: '2026-11-13', native: false, checks: [], failures: [], pageErrors: [] };
await mkdir(output, { recursive: true });
let browser;
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (server && server.exitCode !== null) throw Error(logs.join(''));
    try { ready = (await fetch(base)).ok; } catch { /* Wait for isolated preview. */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, `Preview must start: ${logs.join('')}`);
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  for (const style of ['windows', 'dynamic']) {
    for (const width of [1100, 820, 480]) {
      const page = await browser.newPage({ viewport: { width, height: 820 }, locale: 'zh-CN', reducedMotion: 'reduce' });
      page.setDefaultTimeout(5000);
      page.on('pageerror', error => report.pageErrors.push(error.message));
      const name = `${style} at ${width}px: fork/join, endpoint alignment, size switch and selection`;
      try {
        await page.addInitScript(values => localStorage.setItem('island-workbench-settings-v1', JSON.stringify(values)), {
          'shell.configVersion': 1, 'app.language': 'zh-CN', 'appearance.style': style,
          'island.openOn': 'click', 'tasks.displaySize': 'large', 'tasks.cardEffect': 'minimal',
        });
        await page.goto(`${base}/?workbench=simulation`);
        await page.locator('[data-workbench-summary]').waitFor();
        await page.locator('[data-hit="true"]').first().click();
        await page.getByRole('combobox', { name: '演示场景' }).selectOption('fork-join');
        const card = page.locator('[data-route-card="sim/plan/fork-join"]');
        await card.waitFor();
        await page.waitForTimeout(400);
        const graph = card.locator('.wb-route-body .wb-group-graph');
        assert.equal(await graph.getAttribute('data-graph-renderer'), 'react-git-log-adapted');
        assert.equal(await graph.locator('[data-step-key]').count(), 14);
        assert.equal(await graph.locator('[data-merge="true"]').count(), 2);
        assert.equal(await graph.locator('path[data-from]').count(), 16);
        assert.equal(await card.locator('.wb-graph-legend li').count(), 4);
        assert.equal(await card.locator('.wb-graph-legend i').evaluateAll(elements => new Set(elements.map(element => element.style.background)).size), 4);
        assert.equal(await graph.locator('button, line').count(), 0);
        const alignment = await graph.evaluate(element => {
          const svg = element.querySelector('svg');
          const matrix = svg.getScreenCTM();
          const errors = [];
          for (const edge of svg.querySelectorAll('path[data-from]')) {
            const points = [[edge.dataset.from, edge.getPointAtLength(0)],
              [edge.dataset.to, edge.getPointAtLength(edge.getTotalLength())]];
            for (const [key, point] of points) {
              const station = [...element.querySelectorAll('[data-step-key]')].find(node => node.dataset.stepKey === key);
              const bounds = station.querySelector('.wb-dot').getBoundingClientRect();
              const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix);
              const distance = Math.hypot(screen.x - bounds.x - bounds.width / 2, screen.y - bounds.y - bounds.height / 2);
              if (distance > 1.2) errors.push({ key, distance });
            }
          }
          return errors;
        });
        assert.deepEqual(alignment, [], 'Every drawn edge must meet the actual station center');
        const curves = await graph.locator('path').evaluateAll(paths => paths.filter(edge => edge.getAttribute('d').includes(' Q ')).length);
        assert.ok(curves >= 6, 'Both forks and joins must use rounded curves');
        const lane = card.locator('.wb-group-lane');
        const list = page.locator('[data-workbench-routes]');
        const outerTop = await list.evaluate(element => element.scrollTop);
        await lane.hover({ position: { x: 90, y: 35 } });
        await page.mouse.wheel(0, 240);
        await page.waitForTimeout(150);
        assert.ok(await lane.evaluate(element => element.scrollLeft > 0), 'Wheel still scrolls a long graph');
        assert.equal(await list.evaluate(element => element.scrollTop), outerTop);
        await lane.evaluate(element => { element.scrollLeft = 0; });
        await page.screenshot({ path: path.join(output, `${style}-${width}-expanded.png`) });
        await card.screenshot({ path: path.join(output, `${style}-${width}-card.png`) });
        await lane.evaluate(element => { element.scrollLeft = element.scrollWidth; });
        await page.screenshot({ path: path.join(output, `${style}-${width}-joins.png`) });
        await card.locator('[data-route-select]').focus();
        await page.keyboard.press('Enter');
        await page.locator('[data-task-size-toggle]').click();
        await page.waitForTimeout(400);
        assert.equal(await page.locator('.wb').getAttribute('data-task-size'), 'small');
        const thumbnail = card.locator('.wb-row-thumbnail .wb-group-graph');
        assert.equal(await thumbnail.locator('[data-step-key]').count(), 14);
        assert.equal(await thumbnail.textContent(), '');
        assert.equal(await thumbnail.locator('path[data-from]').count(), 16);
        await page.screenshot({ path: path.join(output, `${style}-${width}-compact.png`) });
        await page.keyboard.press('Escape');
        const summary = page.locator('[data-workbench-summary]');
        await summary.waitFor();
        assert.equal(await summary.locator('[data-route-key]').getAttribute('data-route-key'), 'sim/plan/fork-join/route/main');
        assert.equal(await summary.locator('.wb-mini-stop').count(), 8);
        await page.waitForTimeout(200);
        await page.locator('[data-hit="true"]').first().click();
        assert.equal(await card.locator('[data-route-select]').getAttribute('aria-pressed'), 'true');
        await page.locator('[data-task-size-toggle]').click();
        await page.waitForTimeout(350);
        const left = await lane.evaluate(element => element.scrollLeft);
        await page.waitForTimeout(1200);
        assert.equal(await lane.evaluate(element => element.scrollLeft), left, 'Polling must preserve graph reading position');
        report.checks.push(name);
      } catch (error) {
        report.failures.push({ name, error: String(error.stack) });
        await page.screenshot({ path: path.join(output, `${style}-${width}-failed.png`) });
      } finally { await page.close(); }
    }
  }
} finally {
  await browser?.close();
  server?.kill();
  report.passed = !report.failures.length && !report.pageErrors.length && report.checks.length === 6;
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
}
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
