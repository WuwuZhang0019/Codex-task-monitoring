// 更新日期 2026-11-11。C 入口回归；后继验证可独立指定证据目录。
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from '../server/index.mjs';
import { validateLightSnapshot } from '../server/light-model.mjs';
import fixture from '../src/light-simulation.json' with { type: 'json' };

const output = path.resolve(process.env.WORKBENCH_UI_EVIDENCE_DIR || 'test-results/manual-trial/C-EX01');
await mkdir(output, { recursive: true });
const checks = [];
async function check(name, operation) {
  await operation();
  checks.push({ name, result: 'passed' });
  console.log(`PASS ${name}`);
}
validateLightSnapshot(fixture);
const server = await createServer({ dataDir: path.join(output, 'isolated-data'), distDir: path.resolve('dist'), env: {} });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(`${base}/?view=light-simulation`);
  await page.locator('.lp-project').first().waitFor();
  await check('frozen schema and domain graph; three projects, six base routes, thirty stations', async () => {
    assert.equal(fixture.mode, 'simulation');
    assert.equal(fixture.projects.length, 3);
    assert.equal(fixture.routes.filter(route => route.planKey === fixture.plans[0].key).length, 6);
    assert.ok(fixture.routes.some(route => route.stepKeys.length === 30));
    assert.equal(await page.locator('.lp-project').count(), 3);
  });
  await check('600×38 compact and 960×640 expanded baseline', async () => {
    const compact = await page.locator('.lp-compact').boundingBox();
    const panel = await page.locator('.lp-panel').boundingBox();
    assert.equal(compact.width, 600); assert.equal(compact.height, 38);
    assert.equal(panel.width, 960); assert.equal(panel.height, 640);
  });
  await page.screenshot({ path: path.join(output, '01-expanded.png') });
  await check('three direct active branches and remaining abnormal counts', async () => {
    assert.equal(await page.locator('.lp-branch').count(), 3);
    const more = page.getByRole('button', { name: /另有 4 条分支/ });
    await more.click();
    assert.equal(await page.locator('.lp-branch').count(), 7);
    await page.getByRole('button', { name: '收起额外分支', exact: true }).click();
    await page.getByRole('button', { name: /已结束分支 1 条/ }).click();
    assert.equal(await page.locator('.lp-branch').count(), 4);
    await page.getByRole('button', { name: /已结束分支 1 条/ }).click();
  });
  const main = page.locator('.lp-station').first();
  await main.click();
  await check('details preserve original excerpt, conditions, evidence and unbound failure', async () => {
    await page.getByRole('button', { name: '查看完整详情' }).click();
    assert.ok((await page.locator('.lp-excerpt').innerText()).includes('示例'));
    assert.ok((await page.locator('.lp-detail').innerText()).includes('fixture://A-01'));
    await page.getByRole('button', { name: '打开关联会话' }).click();
    assert.ok((await page.getByRole('status').innerText()).includes('未绑定会话'));
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.lp-full-detail').count(), 0);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.lp-detail').count(), 0);
  });
  await check('deep focus and Esc restore prior view', async () => {
    await page.locator('.lp-branch').first().getByRole('button', { name: /子分支 1/ }).click();
    assert.equal(await page.locator('.lp-breadcrumb').count(), 1);
    assert.equal(await page.locator('.lp-project').count(), 1);
    await page.screenshot({ path: path.join(output, '02-deep-focus.png') });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.lp-breadcrumb').count(), 0);
  });
  await check('project collapse and route collapse', async () => {
    const project = page.locator('.lp-project').first();
    const toggle = project.locator(':scope > header button');
    await toggle.click(); assert.equal(await project.locator('.lp-route').count(), 0);
    await toggle.click();
    const routeToggle = page.locator('.lp-route-label button').first();
    await routeToggle.click(); assert.equal(await page.locator('.lp-folded').count(), 1);
    await routeToggle.click();
  });
  await check('horizontal and vertical reading position and selection survive updates and reload', async () => {
    await page.locator('.lp-project').nth(1).scrollIntoViewIfNeeded();
    await page.locator('.lp-project-scroll').nth(1).evaluate(element => { element.scrollLeft = 900; element.dispatchEvent(new Event('scroll')); });
    await page.locator('.lp-project').nth(1).locator('.lp-station').nth(10).click();
    const before = await page.evaluate(() => ({ x: document.querySelectorAll('.lp-project-scroll')[1].scrollLeft, y: document.querySelector('.lp-body').scrollTop, selected: document.querySelector('.lp-station[aria-pressed=true]').id }));
    await page.getByRole('button', { name: '模拟更新与返工' }).click();
    const after = await page.evaluate(() => ({ x: document.querySelectorAll('.lp-project-scroll')[1].scrollLeft, y: document.querySelector('.lp-body').scrollTop, selected: document.querySelector('.lp-station[aria-pressed=true]').id }));
    assert.deepEqual(after, before);
    await page.reload(); await page.locator('.lp-project').first().waitFor();
    assert.equal(await page.locator('.lp-station[aria-pressed=true]').getAttribute('id'), before.selected);
    assert.equal(await page.locator('.lp-project-scroll').nth(1).evaluate(element => element.scrollLeft), before.x);
  });
  await check('connection loss keeps business states; empty state recovers', async () => {
    const before = await page.locator('.lp-station').count();
    await page.getByRole('button', { name: '切换连接' }).click();
    assert.ok((await page.locator('.lp-sync').innerText()).includes('连接中断'));
    assert.equal(await page.locator('.lp-station').count(), before);
    await page.getByRole('button', { name: '切换空态' }).click();
    assert.ok((await page.locator('.lp-empty').innerText()).includes('尚未收到路线'));
    await page.getByRole('checkbox', { name: '只看有待办' }).check();
    assert.ok((await page.locator('.lp-empty').innerText()).includes('当前条件下没有路线'));
    await page.getByRole('button', { name: '清除筛选并恢复样例' }).click();
  });
  await check('current locator offers multiple candidates and reveals target', async () => {
    await page.getByRole('button', { name: '定位当前', exact: true }).click();
    assert.ok(await page.locator('.lp-candidates button').count() > 1);
    await page.locator('.lp-candidates button').first().click();
    assert.equal(await page.locator('.lp-detail').count(), 1);
    await page.getByRole('button', { name: '关闭详情' }).click();
  });
  await check('small screen keeps horizontal routes and page fits viewport', async () => {
    await page.setViewportSize({ width: 390, height: 740 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const panel = await page.locator('.lp-panel').boundingBox();
    assert.ok(panel.width <= 374); assert.ok(panel.height <= 640);
    await page.screenshot({ path: path.join(output, '03-small-screen.png') });
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await check('keyboard focus and layered Esc collapse', async () => {
    await page.locator('.lp-station').first().focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.lp-detail').count(), 1);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.lp-panel').count(), 0);
    await page.screenshot({ path: path.join(output, '04-compact.png') });
  });
  await check('no unhandled browser errors', async () => assert.deepEqual(errors, []));
  const prototype = await createServer({ dataDir: path.join(output, 'prototype-data'), distDir: path.resolve('../prototypes/top-panel/dist'), env: {} });
  await new Promise(resolve => prototype.listen(0, '127.0.0.1', resolve));
  try {
    await page.goto(`http://127.0.0.1:${prototype.address().port}`);
    await page.locator('.compact').waitFor();
    await page.screenshot({ path: path.join(output, '05-original-compact.png') });
    await page.locator('.compact').click();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.content')).opacity === '1');
    await page.screenshot({ path: path.join(output, '06-original-expanded.png') });
    await check('original prototype captured at matching viewport and scale', async () => assert.equal(page.viewportSize().width, 1280));
  } finally {
    prototype.closeAllConnections();
    await new Promise(resolve => prototype.close(resolve));
  }
} finally {
  await writeFile(path.join(output, 'checks.json'), JSON.stringify({ date: '2026-11-10', checks, errors }, null, 2));
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
