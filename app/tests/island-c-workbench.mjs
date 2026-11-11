// 更新日期：2026-11-12。C 模拟视图验收，不连接正式业务服务。
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const out = path.resolve(process.env.ISLAND_EVIDENCE_DIR || '../docs/03_轻量路线工作台/06_执行记录/island-workbench-20261111/assets/C/browser');
await mkdir(out, { recursive: true });
const report = { date: process.env.ISLAND_TEST_DATE || new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date()), native: false, checks: [], failures: [], errors: [], requests: [], styles: [] };
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
const check = async (name, fn) => { try { report.checks.push({ name, result: 'passed', details: await fn() }); } catch (e) { report.failures.push({ name, error: String(e.stack) }); } };
for (const style of ['dynamic', 'windows']) {
 const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN', recordVideo: { dir: out, size: { width: 1280, height: 800 } } });
 await context.addInitScript(style => { if (!sessionStorage.getItem('c-seeded')) { localStorage.setItem('island-workbench-settings-v1', JSON.stringify({ 'shell.configVersion': 1, 'app.language': 'zh-CN', 'appearance.style': style })); sessionStorage.setItem('c-seeded', '1'); } }, style);
 const page = await context.newPage();
 page.setDefaultTimeout(5000);
 page.on('pageerror', e => report.errors.push(e.message));
 page.on('request', r => { if (/api\/|light-panel|light-mcp/.test(r.url())) report.requests.push(r.url()); });
 const shell = page.locator('[data-hit]').first();
 const snap = async name => { const geometry = await shell.boundingBox(); await page.screenshot({ path: path.join(out, `${style}-${name}.png`) }); return geometry; };
 const hover = async () => { const b = await shell.boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + 15); await page.waitForTimeout(1150); };
 const open = async () => { await shell.click({ position: { x: 100, y: 15 } }); await page.waitForTimeout(900); };
 try {
  await page.goto('http://127.0.0.1:1420/?workbench=simulation#settings', { waitUntil: 'networkidle' });
  await page.locator('nav').getByText('外观', { exact: true }).click();
  await page.getByRole('button', { name: style === 'dynamic' ? /刘海模式/ : /Windows 灵动岛/ }).click();
  await page.goto('http://127.0.0.1:1420/?workbench=simulation', { waitUntil: 'networkidle' });
  await page.mouse.move(20, 700); await page.waitForTimeout(1400);
  const compact = await snap('collapsed');
  await check(`${style} 收起摘要`, async () => { assert.ok(await page.locator('[data-workbench-summary]').isVisible()); assert.match(await page.locator('[data-workbench-summary]').innerText(), /模拟/); return compact; });
  const b = await shell.boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + 15); await page.waitForTimeout(180); const transition = await snap('transition'); await page.waitForTimeout(1100);
  const expanded = await snap('expanded');
  report.styles.push({ style, compact, transition, expanded });
  await check(`${style} 原外壳形变及内容过渡`, async () => { assert.ok(expanded.height > compact.height + 100); assert.ok(transition.height > compact.height && transition.height < expanded.height + 40); assert.equal(await page.locator('[data-workbench]').count(), 1); });
  await check(`${style} 多项目五状态六路线及只读`, async () => { assert.equal(await page.locator('[data-project-key]').count(), 3); for (const s of ['pending', 'running', 'blocked', 'completed', 'cancelled']) assert.ok(await page.locator(`[data-status="${s}"]`).count()); assert.equal(await page.locator('[data-project-key="sim/project/workbench"] [data-route-key]').count(), 10); await page.locator('[data-step-key="sim/plan/main/step/4"]').click(); assert.match(await page.locator('[data-workbench-detail]').innerText(), /等待原生环境核验/); });
  await check(`${style} 刷新保留选择与滚动`, async () => { await page.locator('[data-workbench-routes]').evaluate(e => { e.scrollTop = 230; }); const before = await page.locator('[data-workbench-routes]').evaluate(e => e.scrollTop); await page.getByRole('button', { name: '刷新', exact: true }).click(); assert.equal(await page.locator('[data-workbench-routes]').evaluate(e => e.scrollTop), before); assert.match(await page.locator('[data-workbench-detail]').innerText(), /sim\/plan\/main\/step\/4/); });
  await check(`${style} 定位当前与事件定位`, async () => { await page.getByRole('button', { name: '定位当前', exact: true }).click(); assert.match(await page.locator('[data-workbench-detail]').innerText(), /sim\/plan\/main\/step\/3/); await page.locator('[data-event-id]').click(); assert.match(await page.locator('[data-workbench-detail]').innerText(), /sim\/plan\/main\/step\/4/); assert.equal(await page.locator('[data-event-id]').count(), 1); });
  await check(`${style} 长路线横向滚动`, async () => { const lane = page.locator('[data-route-key="sim/plan/long/route/1"]'); await lane.evaluate(e => { e.scrollLeft = 1000; }); assert.ok(await lane.evaluate(e => e.scrollWidth > e.clientWidth && e.scrollLeft >= 999)); await page.getByRole('button', { name: '刷新', exact: true }).click(); assert.ok(await lane.evaluate(e => e.scrollLeft >= 999)); });
  await check(`${style} 深分支及细分详情`, async () => { await page.getByRole('button', { name: '定位当前', exact: true }).click(); const detail = page.locator('[data-workbench-detail]'); await detail.locator('[data-linked-plan]').first().click(); assert.match(await detail.innerText(), /sim\/plan\/branch\/1/); await page.getByRole('button', { name: '定位当前', exact: true }).click(); await detail.getByRole('button', { name: /C-03-01/ }).click(); assert.match(await detail.innerText(), /视图内部细分任务/); });
  await check(`${style} 故障与未知结果不触发写入`, async () => { const select = page.getByRole('combobox', { name: '演示场景' }); for (const id of ['offline', 'unauthorized', 'stale', 'incompatible']) { await select.selectOption(id); await page.locator(`[data-connection="${id}"]`).waitFor(); assert.match(await page.locator('[data-workbench]').innerText(), /模拟数据/); assert.ok(await page.locator('[data-project-key]').count() > 0); await snap(id); } await select.selectOption('unknown'); await page.locator('[data-unknown-result]').waitFor(); await page.getByRole('button', { name: '刷新', exact: true }).click(); assert.match(await page.locator('[data-unknown-result]').innerText(), /sim\/event\/unknown-result/); await page.getByRole('button', { name: '查询原事件', exact: true }).click(); await page.locator('[data-unknown-result]').waitFor({ state: 'detached' }); });
  await check(`${style} 空快照不是全部完成`, async () => { await page.getByRole('combobox', { name: '演示场景' }).selectOption('empty'); assert.match(await page.locator('[data-workbench]').innerText(), /空快照不代表任务已全部完成/); assert.equal(await page.locator('[data-project-key]').count(), 0); await snap('empty'); await page.getByRole('combobox', { name: '演示场景' }).selectOption('multi-project'); });
  await check(`${style} 固定移出与取消固定收起`, async () => { await page.getByTitle('固定展开', { exact: true }).click(); await page.mouse.move(20, 700); await page.waitForTimeout(1300); assert.ok((await shell.boundingBox()).height > 300); await snap('pinned'); await page.getByTitle('取消固定', { exact: true }).click(); await page.mouse.move(20, 700); await page.waitForTimeout(1700); assert.ok((await shell.boundingBox()).height < 60); });
  await check(`${style} 快速进出与再次展开`, async () => { for (let i = 0; i < 6; i++) { const b = await shell.boundingBox(); await page.mouse.move(b.x + 80, b.y + 15); await page.waitForTimeout(55); await page.mouse.move(20, 700); await page.waitForTimeout(55); } await page.waitForTimeout(1600); assert.ok((await shell.boundingBox()).height < 60); await hover(); assert.ok((await shell.boundingBox()).height > 300); await snap('reopened'); });
  await check(`${style} Tab Enter与Esc及收起再开保留`, async () => { await page.getByRole('button', { name: '定位当前', exact: true }).focus(); await page.keyboard.press('Enter'); assert.match(await page.locator('[data-workbench-detail]').innerText(), /sim\/plan\/main\/step\/3/); await page.getByRole('button', { name: '刷新', exact: true }).focus(); await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'SELECT'); await page.keyboard.press('Escape'); await page.waitForTimeout(1000); assert.ok((await shell.boundingBox()).height < 60); await open(); assert.match(await page.locator('[data-workbench-detail]').innerText(), /sim\/plan\/main\/step\/3/); });
 } catch (e) { report.failures.push({ style, error: String(e.stack) }); await snap('failure').catch(() => {}); }
 await context.close();
}
await browser.close();
report.passed = !report.failures.length && !report.errors.length && !report.requests.length;
await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
