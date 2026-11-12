// 日期：2026-11-12。F 最小浏览器回归，不替代原生验收或启动正式服务。
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire('G:/rust/Codex-task-monitoring/app/package.json');
const { chromium } = require('@playwright/test');
const [checkout, output] = process.argv.slice(2);
if (!checkout || !output || !path.isAbsolute(checkout) || !path.isAbsolute(output)) throw Error('Pass absolute clean checkout and output paths');
await fs.mkdir(output, { recursive: true });
const bun = 'G:/rust/Codex-task-monitoring/app/test-results/island-A-tools/node_modules/bun/bin/bun.exe';
const port = 1458;
const server = spawn(bun, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: checkout, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', data => { serverLog += data; });
server.stderr.on('data', data => { serverLog += data; });
const report = { date: '2026-11-12', checkout, mode: 'browser preview; no native IPC or formal data writes', checks: [], errors: [], passed: false };
let browser;
const check = (name, test, detail) => { assert.ok(test, name); report.checks.push({ name, result: 'passed', detail }); };
try {
  for (let index = 0; index < 100; index++) {
    try { if ((await fetch(`http://127.0.0.1:${port}`)).ok) break; } catch {}
    if (index === 99) throw Error('PREVIEW_SERVER_TIMEOUT');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const context = await browser.newContext({ viewport: { width: 1000, height: 750 }, locale: 'zh-CN' });
  await context.addInitScript(() => {
    localStorage.setItem('island-workbench-settings-v1', JSON.stringify({ 'app.language': 'zh-CN', 'shell.configVersion': 1 }));
    window.__opened = [];
    window.open = (url, target, features) => { window.__opened.push({ url, target, features }); return null; };
  });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/#settings`, { waitUntil: 'networkidle' });
  await page.locator('nav a[href="/about"]').waitFor();
  check('任务岛窗口标题', (await page.title()) === '任务岛', await page.title());
  const links = await page.locator('nav a').allTextContents();
  check('保留五个侧栏入口', links.join('|').includes('常规|外观|行为|工作台|关于'), links);
  const sections = await page.locator('nav > span').allTextContents();
  check('新增灵动岛分类存在', sections.includes('灵动岛'), sections);
  await page.locator('nav a[href="/workbench"]').click();
  await page.getByText('工作台连接与绑定确认', { exact: true }).waitFor();
  check('分类下工作台入口可达', await page.getByText('工作台连接与绑定确认', { exact: true }).isVisible());
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('main > div')).opacity) >= 0.999);
  await page.screenshot({ path: path.join(output, 'workbench-category.png') });
  await page.locator('nav a[href="/about"]').click();
  await page.getByRole('button', { name: '许可证', exact: true }).waitFor();
  check('关于显示任务岛及产品版本', (await page.locator('main').innerText()).includes('任务岛') && (await page.locator('main').innerText()).includes('0.1.0'));
  check('许可证及原作者和修改日期', (await page.locator('main').innerText()).includes('GPL-3.0-or-later · © HeyyCzer · 致谢 Vorssaint · 修改日期：2026-11-12'));
  check('自有更新未配置明确提示', await page.getByText('更新暂不可用：自有发布源尚未配置', { exact: true }).isVisible());
  const logo = page.locator('main svg[viewBox="0 0 1024 1024"]');
  check('独立自绘三节点标识', await logo.locator('circle').count() === 3 && await logo.locator('circle[fill="#38d9d0"]').count() === 1);
  await page.getByRole('button', { name: '许可证', exact: true }).click();
  await page.getByRole('button', { name: '上游来源', exact: true }).click();
  await page.getByRole('button', { name: 'GitHub', exact: true }).click();
  const opened = await page.evaluate(() => window.__opened);
  check('许可证链接固定上游提交且noopener', opened[0]?.url === 'https://github.com/HeyyCzer/windows-dynamic-island/blob/e286d9045746837bf1960e0d13b7ed572b8d9e50/LICENSE' && opened[0]?.features === 'noopener', opened[0]);
  check('上游与Fork入口各自准确', opened[1]?.url === 'https://github.com/HeyyCzer/windows-dynamic-island' && opened[2]?.url === 'https://github.com/WuwuZhang0019/windows-dynamic-island', opened.slice(1));
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('main > div')).opacity) >= 0.999);
  await page.screenshot({ path: path.join(output, 'about-license-and-logo.png') });
  check('无页面异常', report.errors.length === 0, report.errors);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill();
  await fs.writeFile(path.join(output, 'preview-server.log'), serverLog, 'utf8');
  await fs.writeFile(path.join(output, 'browser-regression_2026-11-12.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failure: report.failure }));
}
