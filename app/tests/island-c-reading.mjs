// 日期：2026-11-11。阅读位置与窄窗口回归，使用独立浏览器上下文。
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
await context.addInitScript(() => localStorage.setItem('island-workbench-settings-v1', JSON.stringify({ 'shell.configVersion': 1, 'app.language': 'zh-CN', 'appearance.style': 'windows', 'appearance.border': 'intelligence' })));
const page = await context.newPage();
const report = { date: '2026-11-11', checks: [], errors: [] };
page.on('pageerror', e => report.errors.push(e.message));
try {
 await page.goto('http://127.0.0.1:1420/', { waitUntil: 'networkidle' });
 const shell = page.locator('[data-hit]').first();
 await shell.click(); await page.waitForTimeout(900);
 await page.screenshot({ path: '../docs/03_轻量路线工作台/06_执行记录/island-workbench-20261111/assets/C/browser/windows-intelligence-comparison.png' });
 const select = page.getByRole('combobox', { name: '演示场景' });
 await select.selectOption('long-route');
 assert.equal(await page.locator('[data-project-key]').count(), 1);
 assert.equal(await page.locator('[data-step-key]').count(), 60);
 report.checks.push('独立长路线样例60阶段');
 await select.selectOption('deep-branch');
 assert.equal(await page.locator('[data-project-key]').count(), 1);
 assert.equal(await page.locator('[data-linked-plan]').count(), 1);
 for (let level = 1; level <= 4; level++) {
  await page.locator('[data-linked-plan]').click();
  assert.match(await page.locator('[data-workbench-detail]').innerText(), new RegExp(`sim/plan/branch/${level}/step/1`));
  if (level < 4) await page.locator(`[data-step-key="sim/plan/branch/${level}/step/2"]`).click();
 }
 report.checks.push('四层关联分支实际导航');
 await select.selectOption('multi-project');
 await page.getByRole('button', { name: '定位当前', exact: true }).click();
 const input = page.locator('[data-workbench-detail] input').first();
 await input.focus(); await page.mouse.move(10, 750); await page.waitForTimeout(1500);
 assert.ok((await shell.boundingBox()).height > 300);
 assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'INPUT');
 report.checks.push('详情输入焦点期间移出保持展开');
 await page.locator('[data-workbench-detail]').evaluate(e => { e.scrollTop = 220; });
 const detailScroll = await page.locator('[data-workbench-detail]').evaluate(e => e.scrollTop);
 const lanes = page.locator('[data-route-key="sim/plan/long/route/1"]');
 await lanes.evaluate(e => { e.scrollLeft = 600; });
 const horizontal = await lanes.evaluate(e => e.scrollLeft);
 await page.keyboard.press('Escape'); await page.waitForTimeout(800);
 await shell.click(); await page.waitForTimeout(1000);
 assert.equal(await page.locator('[data-workbench-detail]').evaluate(e => e.scrollTop), detailScroll);
 assert.equal(await lanes.evaluate(e => e.scrollLeft), horizontal);
 report.checks.push('收起再开保留详情纵滚及路线横滚');
 await page.setViewportSize({ width: 600, height: 700 }); await page.waitForTimeout(800);
 const box = await shell.boundingBox(); assert.ok(box.width <= 560 && box.x >= 0);
 assert.ok(await page.locator('[data-workbench-detail]').isVisible());
 report.checks.push('600px窄窗口不超出外壳边界');
 await page.screenshot({ path: '../docs/03_轻量路线工作台/06_执行记录/island-workbench-20261111/assets/C/browser/narrow.png' });
 assert.equal(report.errors.length, 0);
 report.passed = true;
} catch (e) { report.passed = false; report.error = String(e.stack); process.exitCode = 1; }
await browser.close();
await writeFile('../docs/03_轻量路线工作台/06_执行记录/island-workbench-20261111/assets/C/browser/reading-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
