// Date: 2026-11-12. Edge verifies the real settings UI with a controlled native-command substitute.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const root = process.env.ISLAND_SHELL_ROOT ?? 'G:/rust/windows-dynamic-island';
const output = path.resolve('test-results/mcp-auto-connection');
const bun = path.resolve('test-results/island-A-tools/node_modules/bun/bin/bun.exe');
const base = 'http://localhost:1467';
const server = spawn(bun, ['node_modules/vite/bin/vite.js', 'preview', '--port', '1467', '--strictPort'], {
  cwd: root, windowsHide: true, stdio: 'pipe',
});
let browser;
const report = { date: '2026-11-12', environment: 'Edge production UI with controlled native-command substitute; no native authorization issued', checks: [], errors: [] };
await mkdir(output, { recursive: true });
try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { ready = (await fetch(base)).ok; } catch { /* Wait for the preview. */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready);
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1075, height: 775 }, locale: 'zh-CN' });
  page.on('pageerror', error => report.errors.push(error.message));
  await page.addInitScript(() => {
    window.__connection = { state: 'disabled', enabled: false };
    window.__connectionCalls = [];
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'settings' }, currentWebview: { label: 'settings' } },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command, args) => {
        if (command === 'get_settings') return { 'app.language': 'zh-CN', 'shell.configVersion': 1 };
        if (command === 'get_autostart') return false;
        if (command === 'island_agent_connections') {
          if (window.__connection.state === 'unavailable') throw Error('OWNER_UNAVAILABLE');
          return [{ ...window.__connection, appId: 'codex' },
            ...['claude-code', 'dsh', 'workbuddy'].map(appId => ({ appId, state: 'disabled', enabled: false }))];
        }
        if (command === 'island_agent_set_connection') {
          window.__connectionCalls.push({ command, args });
          window.__connection = args.enabled ? { state: 'waiting', enabled: true, automatic: true } : { state: 'disabled', enabled: false };
          return { ...window.__connection, appId: args.appId };
        }
        if (command === 'plugin:event|listen') return 1;
        return null;
      },
    };
  });
  await page.goto(`${base}/#settings`);
  await page.locator('nav').getByText('MCP', { exact: true }).click();
  const card = page.locator('[data-workbench-connection="codex"]');
  assert.equal(await page.locator('[data-workbench-connection]').count(), 4);
  await card.getByText('尚未连接 Codex', { exact: true }).waitFor();
  assert.equal(await card.locator('input, textarea').count(), 0);
  assert.equal(await card.getByRole('button').count(), 1);
  await page.waitForTimeout(350); // Let the existing page/navigation transition settle before visual evidence.
  await page.screenshot({ path: path.join(output, 'disabled.png') });
  report.checks.push('No IDs, paths, JSON, or confirmation checkboxes; one connection button');
  await card.getByRole('button', { name: '连接 Codex', exact: true }).click();
  await card.getByText('等待 Codex 接入', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__connectionCalls[0].args.enabled), true);
  report.checks.push('One click enables automatic connection and honestly waits for Codex');
  await page.evaluate(() => { window.__connection = { state: 'connected', enabled: true, automatic: true }; });
  await card.getByText('已连接 Codex', { exact: true }).waitFor({ timeout: 6000 });
  await page.screenshot({ path: path.join(output, 'connected.png') });
  report.checks.push('Polling shows the connected state after a live lease is reported');
  await page.evaluate(() => { window.__connection = { state: 'disconnected', enabled: true, automatic: true }; });
  await card.getByText('连接已中断', { exact: true }).waitFor({ timeout: 6000 });
  await card.getByRole('button', { name: '关闭自动连接' }).click();
  await card.getByText('尚未连接 Codex', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__connectionCalls.at(-1).args.enabled), false);
  report.checks.push('Lost connection is visible and one click disables/revokes the connection');
  await page.reload();
  await page.locator('nav').getByText('MCP', { exact: true }).click();
  await card.getByText('尚未连接 Codex', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__connectionCalls.length), 0, 'opening settings never issues a grant');
  await page.evaluate(() => { window.__connection = { state: 'unavailable' }; });
  await card.getByText('连接服务暂不可用', { exact: true }).waitFor({ timeout: 6000 });
  report.checks.push('Opening settings is read-only; unavailable service never appears connected');
  assert.deepEqual(report.errors, []);
  report.passed = true;
} finally {
  await browser?.close(); server.kill();
  await writeFile(path.join(output, 'browser.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report));
}
