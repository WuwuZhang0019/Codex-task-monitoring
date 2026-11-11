// 日期：2026-11-11。A 阶段原始浏览器基线；浏览器模拟不能替代原生验收。
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.env.ISLAND_A_BROWSER_OUTPUT || path.join(appDir, 'test-results/island-A/browser');
const assets = path.resolve(appDir, '../docs/03_轻量路线工作台/06_执行记录/island-workbench-20261111/assets/browser');
const base = process.env.ISLAND_A_BASE_URL || 'http://localhost:1420';
const executablePath = process.env.ISLAND_A_BROWSER_EXE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
await mkdir(output, { recursive: true });
await mkdir(assets, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath });
const report = { date: '2026-11-11', sourceCommit: 'e286d9045746837bf1960e0d13b7ed572b8d9e50',
  base, browser: browser.version(), executablePath, viewport: { width: 1280, height: 800 },
  native: false, feed: 'upstream src/dev/mock via startBridge', styles: [] };
try {
  for (const style of ['dynamic', 'windows']) {
    const context = await browser.newContext({ viewport: report.viewport, locale: 'zh-CN',
      recordVideo: { dir: output, size: report.viewport } });
    const page = await context.newPage();
    const started = Date.now();
    const entry = { style, states: [], events: [], errors: [], consoleErrors: [], failures: [], checks: [] };
    report.styles.push(entry);
    page.on('pageerror', e => entry.errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') entry.consoleErrors.push(m.text()); });
    const shell = page.locator('div[data-hit="true"]').first();
    const event = (name, extra = {}) => entry.events.push({ name, elapsedMs: Date.now() - started, ...extra });
    async function snapshot(name) {
      const geometry = await shell.boundingBox();
      const file = style + '-' + name + '.png';
      await page.screenshot({ path: path.join(output, file) });
      await copyFile(path.join(output, file), path.join(assets, file));
      entry.states.push({ name, elapsedMs: Date.now() - started, geometry, screenshot: file });
      return geometry;
    }
    try {
      await page.goto(base + '/#settings', { waitUntil: 'networkidle' });
      await page.getByText('外观', { exact: true }).click();
      await page.getByRole('button', { name: style === 'dynamic' ? /刘海模式 \(Notch\)/ : /Windows 灵动岛 \(Windows Island\)/ }).click();
      if (style === 'windows') await page.getByTitle('Apple 智能', { exact: true }).click();
      await page.screenshot({ path: path.join(output, style + '-appearance.png') });
      await copyFile(path.join(output, style + '-appearance.png'), path.join(assets, style + '-appearance.png'));
      entry.savedSettings = await page.evaluate(() => JSON.parse(localStorage.getItem('island-settings') || '{}'));
      assert.equal(entry.savedSettings['appearance.style'], style);
      entry.checks.push('通过原始设置页面切换样式并保存 localStorage');
      await page.goto(base + '/', { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'Hide', exact: true }).click();
      await page.mouse.move(20, 700);
      await page.waitForTimeout(1700);
      event('collapsed');
      const compact = await snapshot('collapsed');
      assert.ok(compact);
      await page.mouse.move(compact.x + compact.width / 2, compact.y + compact.height / 2);
      event('pointer-enter');
      await page.waitForTimeout(180);
      await snapshot('hover-transition');
      await page.waitForTimeout(1000);
      const expanded = await snapshot('expanded');
      assert.ok(expanded.height > compact.height + 50);
      entry.checks.push('悬停展开高度明显大于收起态');
      await page.getByTitle('固定展开', { exact: true }).click();
      event('pin');
      await page.mouse.move(20, 700);
      await page.waitForTimeout(1300);
      const pinned = await snapshot('pinned-outside');
      assert.ok(pinned.height > compact.height + 50);
      assert.equal(await page.locator('button[aria-pressed="true"]').count(), 1);
      entry.checks.push('固定后指针离开仍保持展开');
      await page.locator('button[aria-pressed="true"]').click();
      event('unpin');
      await page.mouse.move(20, 700);
      await page.waitForTimeout(1600);
      const collapsedAgain = await snapshot('collapsed-after-unpin');
      assert.ok(collapsedAgain.height < expanded.height - 30);
      entry.checks.push('取消固定后离开可收起');
      for (let i = 0; i < 6; i++) {
        const current = await shell.boundingBox();
        await page.mouse.move(current.x + current.width / 2, current.y + Math.min(15, current.height / 2));
        event('rapid-enter', { cycle: i + 1 });
        await page.waitForTimeout(55);
        await page.mouse.move(20, 700);
        event('rapid-leave', { cycle: i + 1 });
        await page.waitForTimeout(55);
      }
      await page.waitForTimeout(1600);
      const rapidEnd = await snapshot('rapid-exit-final');
      assert.ok(rapidEnd.height < expanded.height - 30);
      entry.checks.push('六轮快速进出后最终回到收起态');
      const box = await shell.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + Math.min(15, box.height / 2));
      await page.waitForTimeout(1200);
      await snapshot('expanded-after-rapid');
      entry.checks.push('快速进出后仍可再次展开');
      await page.mouse.move(20, 700);
      await page.waitForTimeout(1400);
      entry.completed = true;
    } catch (error) {
      entry.completed = false;
      entry.failures.push(String(error.stack || error));
      await page.screenshot({ path: path.join(output, style + '-failure.png') }).catch(() => {});
    } finally {
      const video = page.video();
      await context.close();
      const original = await video.path();
      const named = path.join(output, style + '-baseline.webm');
      await copyFile(original, named);
      await copyFile(named, path.join(assets, style + '-baseline.webm'));
      entry.video = style + '-baseline.webm';
    }
  }
} finally {
  await browser.close();
  report.passed = report.styles.every(s => s.completed && s.errors.length === 0);
  await writeFile(path.join(output, 'browser-baseline.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(report, null, 2));
}
if (!report.passed) process.exitCode = 1;
