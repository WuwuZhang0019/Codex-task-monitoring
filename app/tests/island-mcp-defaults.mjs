// Date: 2026-11-12. Edge verifies the real settings UI with a controlled native-command substitute.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const root = process.env.ISLAND_SHELL_ROOT ?? 'G:/rust/windows-dynamic-island';
const output = path.resolve('test-results/mcp-default-applications');
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
    window.__onboardingCopies = [];
    Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.__copiedInstruction=text;}}});
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'settings' }, currentWebview: { label: 'settings' } },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command, args) => {
        if (command === 'get_settings') return { 'app.language': 'zh-CN', 'shell.configVersion': 1 };
        if (command === 'get_autostart') return false;
        if (command === 'island_agent_connections') {
          if (window.__connection.state === 'unavailable') throw Error('OWNER_UNAVAILABLE');
          return window.__connection.state === 'empty' ? [] : [{ ...window.__connection, appId:'codex',name:'Codex' },...(window.__extraApps ?? [])];
        }
        if (command === 'island_agent_set_connection') {
          window.__connectionCalls.push({ command, args });
          if (window.__failNextCommand) { window.__failNextCommand=false; throw Error('OWNER_UNAVAILABLE'); }
          window.__connection = args.enabled ? { state: 'waiting', enabled: true, automatic: true } : { state: 'disabled', enabled: false };
          return { ...window.__connection, appId: args.appId };
        }
        if (command === 'island_agent_onboarding_instructions') {
          window.__onboardingCopies.push(args?.appId ?? "generic");
          return `请为当前应用完成任务岛接入。识别实际名称后 --describe 安装配置，完成后 --complete 自动开启连接，无需回来点击。`;
        }
        if (command === 'plugin:event|listen') return 1;
        return null;
      },
    };
  });
  await page.goto(`${base}/#settings`);
  await page.locator('nav').getByText('MCP', { exact: true }).click();
  await page.locator('[data-workbench-connection="codex"]').waitFor();
  assert.equal(await page.locator('[data-workbench-connection]').count(),15);
  assert.equal(await page.getByRole('button',{name:/备用图标/}).count(),0);
  assert.match(await page.locator('[data-workbench-connection=codex] img').getAttribute('src'),/openai.svg/);
  assert.match(await page.locator('[data-workbench-connection=claude-code] img').getAttribute('src'),/claude-color.svg/);
  assert.equal(await page.getByText('Kimi-K3',{exact:true}).count(),0);
  assert.equal(await page.getByText('GLM-5.3',{exact:true}).count(),0);
  const cols=await page.locator('.mcp-connection-list').evaluate(el=>getComputedStyle(el).gridTemplateColumns);
  assert.equal(cols.split(' ').length,2);
  await page.locator('[data-workbench-connection="claude-code"] button').click();
  assert.equal(await page.evaluate(()=>window.__connectionCalls.length),0);
  assert.match(await page.evaluate(()=>window.__copiedInstruction),/当前应用/);
  await page.evaluate(()=>{window.__connection={state:'connected',enabled:true};window.__extraApps=[{appId:'new-agent',name:'全新 Agent',state:'connected',enabled:true}];});
  await page.locator('[data-workbench-connection="new-agent"]').waitFor({timeout:6000});
  assert.equal(await page.locator('[data-workbench-connection]').count(),16);
  await page.locator('[data-workbench-connection="codex"] [data-connection-tone="connected"]').waitFor();
  await page.waitForTimeout(350);
  await page.screenshot({path:path.join(output,'two-column-defaults.png')});
  report.checks.push('15 agent applications in two columns; no icon library; unregistered shortcuts copy instructions without issuing grants; live and arbitrary applications merge dynamically');
  assert.deepEqual(report.errors, []);
  report.passed = true;
} finally {
  await browser?.close(); server.kill();
  await writeFile(path.join(output, 'browser.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report));
}
