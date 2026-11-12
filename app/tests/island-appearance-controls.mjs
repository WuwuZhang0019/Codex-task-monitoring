// Date: 2026-11-12. Regressions for resting-clock visibility and expanded controls placement.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const root = process.env.ISLAND_SHELL_ROOT;
if (!root) throw Error('Set ISLAND_SHELL_ROOT to the shell checkout.');
const output = path.resolve(process.env.ISLAND_APPEARANCE_OUTPUT || 'test-results/appearance-controls');
const bun = process.env.ISLAND_BUN || path.resolve('test-results/island-A-tools/node_modules/bun/bin/bun.exe');
const port = Number(process.env.ISLAND_APPEARANCE_PORT || 1462);
const base = `http://localhost:${port}`;
const server = spawn(bun, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort'], { cwd: root, windowsHide: true, stdio: 'pipe' });
const logs = [];
server.stdout.on('data', value => logs.push(String(value)));
server.stderr.on('data', value => logs.push(String(value)));
const report = { date: '2026-11-12', native: false, checks: [], failures: [], pageErrors: [] };
let browser;
await mkdir(output, { recursive: true });
const check = async (name, task) => {
  try { report.checks.push({ name, passed: true, details: await task() }); }
  catch (error) { report.failures.push({ name, error: error.stack || String(error) }); }
};
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw Error(`Preview exited: ${logs.join('')}`);
    try { ready = (await fetch(base)).ok; } catch { /* Wait for preview startup. */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Preview must start');
  browser = await chromium.launch({ executablePath: process.env.ISLAND_BROWSER_EXE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 }, locale: 'zh-CN' });
  page.setDefaultTimeout(4000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.goto(base);
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('island-workbench-settings-v1') || '{}'));
  const seed = async values => {
    await page.evaluate(value => localStorage.setItem('island-workbench-settings-v1', JSON.stringify(value)), {
      'shell.configVersion': 1, 'app.language': 'zh-CN', 'appearance.style': 'windows', 'island.openOn': 'click', ...values,
    });
    await page.goto(`${base}/?workbench=simulation`);
    await page.locator('[data-workbench-summary]').waitFor();
    await page.mouse.move(1000, 700);
    await page.waitForTimeout(550);
  };
  const hasClock = () => page.locator('[data-workbench-summary]').evaluate(element => /\d{1,2}:\d{2}/.test(element.parentElement.textContent));
  const appearance = async () => {
    await page.goto(`${base}/#settings`);
    await page.locator('nav').getByText('外观', { exact: true }).click();
    await page.getByRole('heading', { level: 1, name: '外观', exact: true }).waitFor();
    await page.waitForTimeout(300);
  };
  const row = label => page.locator('[data-row]').filter({ has: page.getByText(label, { exact: true }) });

  for (const style of ['windows', 'dynamic']) {
    await check(`${style}: clock off hides time while keeping the complete route`, async () => {
      await seed({ 'appearance.style': style, 'appearance.idleClock': false });
      assert.equal(await hasClock(), false);
      assert.equal(await page.locator('.wb-mini-stop').count(), 3);
    });
    await check(`${style}: clock switch is usable and survives reload`, async () => {
      await appearance();
      const control = row('静止时钟').getByRole('switch');
      assert.equal(await control.getAttribute('aria-checked'), 'false');
      await control.click();
      assert.equal((await saved())['appearance.idleClock'], true);
      await page.goto(`${base}/?workbench=simulation`);
      await page.locator('[data-workbench-summary]').waitFor();
      assert.equal(await hasClock(), true);
      await appearance();
      await row('静止时钟').getByRole('switch').click();
      assert.equal((await saved())['appearance.idleClock'], false);
      await page.goto(`${base}/?workbench=simulation`);
      await page.locator('[data-workbench-summary]').waitFor();
      assert.equal(await hasClock(), false);
    });
    for (const [position, label] of [['top', '顶部'], ['bottom', '底部']]) {
      await check(`${style}: ${position} controls setting moves actual controls and persists`, async () => {
        await seed({ 'appearance.style': style, 'appearance.idleClock': true });
        await appearance();
        await row('模块切换图标位置').getByRole('button', { name: label, exact: true }).click();
        assert.equal((await saved())['appearance.tabsPosition'], position);
        await page.reload();
        await page.locator('nav').getByText('外观', { exact: true }).click();
        await page.getByRole('heading', { level: 1, name: '外观', exact: true }).waitFor();
        await page.waitForTimeout(300);
        assert.equal(await row('模块切换图标位置').getByRole('button', { name: label, exact: true }).getAttribute('aria-pressed'), 'true');
        if (style === 'windows' && position === 'bottom') {
          await row('模块切换图标位置').scrollIntoViewIfNeeded();
          await page.screenshot({ path: path.join(output, 'settings.png') });
        }
        await page.goto(`${base}/?workbench=simulation`);
        const shell = page.locator('[data-hit="true"]').first();
        await shell.click();
        await page.locator('[data-workbench]').waitFor();
        await page.waitForTimeout(700);
        const controls = await page.locator('[data-island-controls]').boundingBox();
        const workbench = await page.locator('[data-workbench]').boundingBox();
        assert.ok(controls && workbench);
        if (position === 'top') assert.ok(controls.y + controls.height <= workbench.y + 1);
        else assert.ok(controls.y >= workbench.y + workbench.height - 1);
        const pin = page.getByTitle('固定展开', { exact: true });
        await pin.click();
        assert.equal(await page.getByTitle('取消固定', { exact: true }).getAttribute('aria-pressed'), 'true');
        await page.keyboard.press('Escape');
        await page.locator('[data-workbench-summary]').waitFor();
        assert.equal(await hasClock(), true);
        return { controls, workbench };
      });
    }
  }
  await check('long route keeps all 60 dots with the clock disabled', async () => {
    await seed({ 'appearance.idleClock': false });
    await page.locator('[data-hit="true"]').first().click();
    await page.getByLabel('演示场景').selectOption('long-route');
    await page.getByLabel('演示场景').blur();
    await page.keyboard.press('Escape');
    await page.locator('[data-workbench-summary]').waitFor();
    await page.waitForTimeout(700);
    assert.equal(await hasClock(), false);
    assert.equal(await page.locator('.wb-mini-stop').count(), 60);
    const dimensions = await page.locator('[data-workbench-summary]').evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
    assert.ok(dimensions.scrollWidth <= dimensions.width);
    await page.screenshot({ path: path.join(output, 'clock-off-long-route.png') });
  });
} finally {
  await browser?.close();
  server.kill();
  report.passed = report.failures.length === 0 && report.pageErrors.length === 0;
  await writeFile(path.join(output, 'browser.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
}
if (!report.passed) process.exitCode = 1;
