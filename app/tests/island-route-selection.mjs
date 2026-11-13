// Date: 2026-11-13. Exercise real pointer hit targets before checking the collapsed route.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const root = process.env.ISLAND_SHELL_ROOT || 'G:/rust/windows-dynamic-island';
const output = path.resolve(process.env.ISLAND_SELECTION_OUTPUT || 'test-results/route-selection');
const base = process.env.ISLAND_BROWSER_URL || 'http://localhost:1472';
const bun = process.env.BUN_EXECUTABLE || path.resolve('test-results/island-A-tools/node_modules/bun/bin/bun.exe');
const server = process.env.ISLAND_BROWSER_URL ? null : spawn(bun,
  ['node_modules/vite/bin/vite.js', 'preview', '--port', '1472', '--strictPort'],
  { cwd: root, windowsHide: true, stdio: 'pipe' });
const logs = [];
server?.stdout.on('data', chunk => logs.push(String(chunk)));
server?.stderr.on('data', chunk => logs.push(String(chunk)));
const report = { date: '2026-11-13', native: false, checks: [], failures: [], pageErrors: [] };
await mkdir(output, { recursive: true });
let browser;
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (server && server.exitCode !== null) throw Error(logs.join(''));
    try { ready = (await fetch(base)).ok; } catch { /* Wait for preview. */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Shell preview must start');
  browser = await chromium.launch({ headless: true,
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  for (const style of ['windows', 'dynamic']) {
    for (const target of ['title', 'graph', 'station', 'thumbnail', 'thumbnail-station', 'keyboard']) {
      const page = await browser.newPage({ viewport: { width: 1100, height: 820 }, locale: 'zh-CN' });
      page.setDefaultTimeout(4000);
      page.on('pageerror', error => report.pageErrors.push(error.message));
      await page.addInitScript(values => localStorage.setItem('island-workbench-settings-v1', JSON.stringify(values)), {
        'shell.configVersion': 1, 'app.language': 'zh-CN', 'appearance.style': style,
        'island.openOn': 'click', 'tasks.displaySize': target.startsWith('thumbnail') ? 'small' : 'large',
      });
      const name = `${style}: ${target} selects the collapsed route`;
      try {
        await page.goto(`${base}/?workbench=simulation`);
        const summary = page.locator('[data-workbench-summary]');
        await summary.waitFor();
        assert.equal(await summary.locator('.wb-mini-stop').count(), 3);
        await page.locator('[data-hit="true"]').first().click();
        const card = page.locator('[data-route-card="sim/plan/long"]');
        await card.scrollIntoViewIfNeeded();
        await page.waitForTimeout(650);
        if (target === 'graph') {
          const lane = card.locator('.wb-group-lane');
          await lane.hover({ position: { x: 120, y: 40 } });
          const top = await page.locator('[data-workbench-routes]').evaluate(element => element.scrollTop);
          await page.mouse.wheel(0, 240);
          await page.waitForTimeout(150);
          assert.ok(await lane.evaluate(element => element.scrollLeft > 0), 'Graph wheel still scrolls the route');
          assert.equal(await page.locator('[data-workbench-routes]').evaluate(element => element.scrollTop), top);
          assert.equal(await card.locator('[data-route-select]').getAttribute('aria-pressed'), 'false');
          await lane.evaluate(element => { element.scrollLeft = 0; });
          // Drag handles must keep their independent keyboard sorting action.
          await card.locator('[data-route-drag]').focus();
          await page.keyboard.press('ArrowUp');
          assert.equal(await card.locator('[data-route-select]').getAttribute('aria-pressed'), 'false');
          await page.keyboard.press('ArrowDown');
          await page.waitForTimeout(350);
        }
        if (target === 'keyboard') {
          await card.locator('[data-route-select]').focus();
          await page.keyboard.press('Enter');
        } else {
          const surface = target.startsWith('thumbnail') ? '.wb-row-thumbnail' : '.wb-route-body';
          const locator = target === 'title' ? card.locator('h2')
            : target.endsWith('station') ? card.locator(`${surface} .wb-graph-step .wb-dot`).first()
              : card.locator(`${surface} .wb-group-graph`);
          const bounds = await locator.boundingBox();
          assert.ok(bounds);
          // Raw mouse input catches overlays that locator.click() can hide by retrying.
          await page.mouse.click(bounds.x + Math.min(bounds.width / 2, 140), bounds.y + bounds.height / 2);
        }
        assert.equal(await card.locator('[data-route-select]').getAttribute('aria-pressed'), 'true');
        // Collapse immediately: the local selection must not wait for a service poll.
        await page.keyboard.press('Escape');
        await summary.waitFor();
        assert.equal(await summary.locator('[data-route-key]').getAttribute('data-route-key'), 'sim/plan/long/route/1');
        assert.equal(await summary.locator('.wb-mini-stop').count(), 60);
        await page.waitForTimeout(350);
        await page.locator('[data-hit="true"]').first().click();
        await page.locator('[data-route-card="sim/plan/main"]').scrollIntoViewIfNeeded();
        await page.locator('[data-route-card="sim/plan/main"] [data-route-select]').focus();
        await page.keyboard.press('Enter');
        await page.keyboard.press('Escape');
        await summary.waitFor();
        assert.equal(await summary.locator('.wb-mini-stop').count(), 3);
        report.checks.push(name);
      } catch (error) {
        report.failures.push({ name, error: String(error.stack) });
        await page.screenshot({ path: path.join(output, `${style}-${target}-failed.png`) });
      } finally { await page.close(); }
    }
  }
} finally {
  await browser?.close();
  server?.kill();
  report.passed = !report.failures.length && !report.pageErrors.length && report.checks.length === 12;
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
}
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
