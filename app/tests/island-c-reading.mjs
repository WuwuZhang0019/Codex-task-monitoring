// 更新日期：2026-11-12。阅读位置与窄窗口回归，使用独立浏览器上下文。
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { writeFile, mkdir } from 'node:fs/promises';
const out = process.env.ISLAND_EVIDENCE_DIR || '../docs/03_轻量路线工作台/06_执行记录/island-workbench-20261111/assets/C/browser';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
await context.addInitScript(() => localStorage.setItem('island-workbench-settings-v1', JSON.stringify({ 'shell.configVersion': 1, 'app.language': 'zh-CN', 'appearance.style': 'windows', 'appearance.border': 'intelligence' })));
const page = await context.newPage();
const report = { date: process.env.ISLAND_TEST_DATE || new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date()), checks: [], errors: [] };
page.on('pageerror', e => report.errors.push(e.message));
try {
 await page.goto(`${process.env.ISLAND_BROWSER_URL || 'http://127.0.0.1:1420'}/?workbench=simulation`, { waitUntil: 'networkidle' });
 const shell = page.locator('[data-hit]').first();
 await shell.click(); await page.waitForTimeout(900);
 await page.screenshot({ path: `${out}/windows-intelligence-comparison.png` });
 const select = page.getByRole('combobox', { name: '演示场景' });
 await select.selectOption('long-route');
 assert.equal(await page.locator('[data-project-key]').count(), 1);
 assert.equal(await page.locator('[data-step-key]').count(), 60);
 report.checks.push('独立长路线样例60阶段');
 await select.selectOption('deep-branch');
 assert.equal(await page.locator('[data-project-key]').count(), 1);
 for (let level = 1; level <= 4; level++) {
  const step = page.locator(`[data-step-key="sim/plan/branch/${level}/step/1"]`);
  await step.click();
  assert.equal(await step.getAttribute('aria-pressed'), 'true');
 }
 assert.equal(await page.locator('[data-workbench-detail]').count(), 0);
 report.checks.push('四层分支直接选择且无详情栏');
 await select.selectOption('multi-project');
 await page.getByRole('button', { name: '定位当前', exact: true }).click();
 const current = page.locator('[data-step-key="sim/plan/main/step/3"]');
 await current.focus(); await page.keyboard.press('Enter');
 assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-step-key')), 'sim/plan/main/step/3');
 report.checks.push('路线节点可通过键盘选择');
 const lanes = page.locator('[data-route-key="sim/plan/long/route/1"]');
 await lanes.evaluate(e => { e.scrollLeft = 600; });
 const horizontal = await lanes.evaluate(e => e.scrollLeft);
 await page.keyboard.press('Escape'); await page.waitForTimeout(800);
 await shell.click(); await page.waitForTimeout(1000);
 assert.equal(await current.getAttribute('aria-pressed'), 'true');
 assert.equal(await lanes.evaluate(e => e.scrollLeft), horizontal);
 report.checks.push('收起再开保留节点选择及路线横滚');
 for (const width of [600, 400]) {
  await page.setViewportSize({ width, height: 700 }); await page.waitForTimeout(800);
  const box = await shell.boundingBox(); assert.ok(box.width <= width - 40 && box.x >= 0);
  const main = await page.locator('.wb-main').boundingBox();
  const routes = await page.locator('[data-workbench-routes]').boundingBox();
  assert.ok(Math.abs(main.width - routes.width) < 2);
  assert.equal(await page.locator('[data-workbench-detail]').count(), 0);
  report.checks.push(`${width}px窄窗口路线用满宽度且无详情栏`);
  await page.screenshot({ path: `${out}/narrow-${width}.png` });
 }
 assert.equal(report.errors.length, 0);
 report.passed = true;
} catch (e) { report.passed = false; report.error = String(e.stack); process.exitCode = 1; }
await browser.close();
await writeFile(`${out}/reading-report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
