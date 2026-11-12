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
  const card = page.locator('[data-workbench-connection="codex"]');
  const button = card.getByRole('button');
  const tone = value => card.locator(`[data-connection-tone="${value}"]`);
  await tone('idle').waitFor();
  assert.equal(await page.locator('[data-workbench-connection]').count(), 1);
  assert.equal(await card.locator('input, textarea').count(), 0);
  assert.equal(await card.getByRole('button').count(), 1);
  assert.equal(await card.locator('p').count(), 0);
  assert.ok((await card.boundingBox()).height < 80, 'connection panel is one compact row');
  assert.ok(await card.locator('img').evaluate(img=>img.complete && img.naturalWidth > 0));
  await button.click();
  await tone('connecting').waitFor();
  assert.equal(await page.evaluate(()=>window.__connectionCalls.at(-1).args.enabled),true);
  const shimmer = await button.evaluate(element=>getComputedStyle(element,'::before').animationName);
  assert.equal(shimmer,'mcp-perimeter-shimmer');
  const angle = await button.evaluate(element=>getComputedStyle(element,'::before').getPropertyValue('--mcp-shimmer-angle'));
  await page.waitForTimeout(180);
  assert.notEqual(await button.evaluate(element=>getComputedStyle(element,'::before').getPropertyValue('--mcp-shimmer-angle')),angle);
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await button.evaluate(element=>getComputedStyle(element,'::before').animationName),'none');
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.screenshot({path:path.join(output,'connecting-shimmer.png')});
  await button.click();
  await tone('idle').waitFor();
  assert.equal(await page.evaluate(()=>window.__connectionCalls.at(-1).args.enabled),false);
  report.checks.push('Gray button connects; yellow button has an animated perimeter and can cancel; reduced-motion disables animation');
  await page.waitForTimeout(350); // Let the existing page/navigation transition settle before visual evidence.
  await page.screenshot({ path: path.join(output, 'disabled.png') });
  report.checks.push('A single universal instruction button replaces all application-specific setup buttons');
  assert.equal(await page.getByRole('button',{name:'复制接入指令',exact:true}).count(),1);
  await page.getByRole('button', { name: '复制接入指令', exact: true }).click();
  assert.match(await page.evaluate(()=>window.__copiedInstruction),/当前应用.*接入/);
  assert.match(await page.evaluate(()=>window.__copiedInstruction),/--complete 自动开启连接/);
  assert.equal(await page.evaluate(()=>window.__connectionCalls.length),2,'copy does not prematurely enable the connection');
  await page.evaluate(()=>{window.__connection={state:'waiting',enabled:true,automatic:true};});
  await tone('connecting').waitFor({timeout:6000});
  report.checks.push('Generic instructions can be reused for new applications; completion updates the connection automatically');
  await page.evaluate(() => { window.__connection = { state: 'connected', enabled: true, automatic: true }; });
  await tone('connected').waitFor({ timeout: 6000 });
  await page.screenshot({ path: path.join(output, 'connected.png') });
  report.checks.push('Polling shows the connected state after a live lease is reported');
  await page.evaluate(() => { window.__connection = { state: 'disconnected', enabled: true, automatic: true }; });
  await tone('failed').waitFor({ timeout: 6000 });
  await button.click();
  await tone('connecting').waitFor();
  assert.equal(await page.evaluate(() => window.__connectionCalls.at(-1).args.enabled), true);
  await page.evaluate(()=>{window.__connection={state:'connected',enabled:true};});
  await tone('connected').waitFor({timeout:6000});
  await button.click();
  await tone('idle').waitFor();
  assert.equal(await page.evaluate(() => window.__connectionCalls.at(-1).args.enabled), false);
  report.checks.push('Interrupted connection is red and retries; green button disconnects with one click');
  await page.reload();
  await page.locator('nav').getByText('MCP', { exact: true }).click();
  await tone('idle').waitFor();
  assert.equal(await page.evaluate(() => window.__connectionCalls.length), 0, 'opening settings never issues a grant');
  assert.equal(await page.evaluate(()=>window.__onboardingCopies.length),0,'opening settings does not mint an installation request');
  await page.evaluate(() => { window.__connection = { state: 'unavailable' }; });
  await page.getByRole('alert').filter({hasText:'连接服务暂不可用'}).waitFor({timeout:6000});
  await tone('failed').waitFor();
  report.checks.push('Opening settings is read-only; unavailable service never appears connected');
  await page.evaluate(()=>{window.__connection={state:'connected',enabled:true};window.__extraApps=[{appId:'new-agent',name:'全新 Agent',state:'connected',enabled:true}];});
  await page.getByText('全新 Agent',{exact:true}).waitFor({timeout:6000});
  assert.equal(await page.getByRole('alert').count(),0,'recovered connection clears stale service warning');
  assert.equal(await page.getByRole('button',{name:'复制接入指令',exact:true}).count(),1);
  const unknown=page.locator('[data-workbench-connection="new-agent"]');
  assert.equal(await unknown.locator('img').count(),0,'unknown applications use the generic icon and still connect');
  await page.screenshot({path:path.join(output,'dynamic-applications.png')});
  report.checks.push('One reusable instruction button; arbitrary application names appear dynamically');
  await page.evaluate(()=>{window.__extraApps=[
    {appId:'claude-code',name:'Claude Code',state:'disabled',enabled:false},
    {appId:'deepseek',name:'DeepSeek',state:'disconnected',enabled:true},
    {appId:'workbuddy',name:'WorkBuddy',state:'waiting',enabled:true}
  ];});
  await page.locator('[data-workbench-connection="workbuddy"]').waitFor({timeout:6000});
  const colors=await page.locator('.mcp-status-button').evaluateAll(elements=>elements.map(el=>({tone:el.dataset.connectionTone,color:getComputedStyle(el).color})));
  assert.equal(new Set(colors.map(x=>x.color)).size,4);
  assert.deepEqual(colors.map(x=>x.tone),['connected','idle','failed','connecting']);
  await page.screenshot({path:path.join(output,'compact-four-states.png')});
  await page.getByRole('button',{name:/备用图标/}).click();
  await page.locator('[data-ai-icon-library]').waitFor();
  assert.equal(await page.locator('.mcp-icon-tile').count(),93);
  await page.waitForFunction(()=>[...document.querySelectorAll('[data-ai-icon-library] img')].every(img=>img.complete && img.naturalWidth>0));
  await page.getByRole('searchbox',{name:'搜索备用图标'}).fill('通义');
  assert.equal(await page.locator('.mcp-icon-tile').count(),1);
  assert.equal(await page.locator('.mcp-icon-tile').innerText(),'Qwen');
  await page.getByRole('searchbox',{name:'搜索备用图标'}).fill('');
  await page.screenshot({path:path.join(output,'local-icon-library.png')});
  report.checks.push('Compact rows show four distinct colors; all 93 locally bundled icons render and Chinese aliases are searchable');
  assert.deepEqual(report.errors, []);
  report.passed = true;
} finally {
  await browser?.close(); server.kill();
  await writeFile(path.join(output, 'browser.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report));
}
