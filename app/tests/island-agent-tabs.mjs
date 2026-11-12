// Date: 2026-11-12. Real Edge UI; controlled native panel data, without changing production authorization.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const root = process.env.ISLAND_SHELL_ROOT ?? 'G:/rust/windows-dynamic-island';
const output = path.resolve('test-results/agent-app-tabs');
const bun = path.resolve('test-results/island-A-tools/node_modules/bun/bin/bun.exe');
const base = 'http://localhost:1468';
const fixture = JSON.parse(execFileSync(bun, ['-e', `import {createScenario} from '${root}/src/workbench/contract/fixtures.ts'; console.log(JSON.stringify(createScenario('multi-project')));`], { encoding: 'utf8', windowsHide: true }));
const snapshot = fixture.snapshot;
snapshot.mode = 'service'; snapshot.revision = 1;
for (const group of ['projects','plans','steps','routes','bindings','executions','supplements'])
  for (const entity of snapshot[group]) { entity.id = `fixture-${entity.key}`; if (group === 'projects') entity.revision = 1; if (group === 'bindings') entity.bindingRevision = 1; }
const first = snapshot.routes[0], second = snapshot.routes.find(route => route.planKey !== first.planKey);
assert.ok(second);
const bindingApps = {};
for (const [route, appId] of [[first, 'codex'], [second, 'claude-code']]) {
  const key = `fixture-binding-${appId}`;
  snapshot.bindings.push({ key, id: key, projectKey: route.projectKey, planKey: route.planKey, stepKeys: route.stepKeys,
    bindingRevision: 1, state: 'confirmed', context: route.context });
  bindingApps[key] = appId;
}
const panel = { snapshot, preferences: null, librarySupported: true, library: { version: 1, archived: [] }, bindingApps,
  agentApps: ['codex','claude-code','dsh','workbuddy'].map(appId => ({ appId, name: appId, enabled: true, connected: ['codex','claude-code'].includes(appId), lastSeenAt: null })) };
const server = spawn(bun, ['node_modules/vite/bin/vite.js','preview','--port','1468','--strictPort'], { cwd: root, windowsHide: true, stdio: 'pipe' });
await mkdir(output, { recursive: true });
let browser;
const report = { date: '2026-11-12', environment: 'Edge UI with controlled native panel substitute', checks: [], pageErrors: [] };
try {
  for (let i=0;i<80;i++) { try { if ((await fetch(base)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve,100)); }
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 }, locale: 'zh-CN' });
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.addInitScript(data => {
    window.__agentPanel = data;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'island' }, currentWebview: { label: 'island' } },
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (cmd) => {
        if (cmd === 'get_settings') return { 'app.language':'zh-CN','shell.configVersion':1,'appearance.style':'windows','island.openOn':'click','island.closeOn':'clickOutside' };
        if (cmd === 'island_workbench_read') return window.__agentPanel;
        if (cmd === 'glass_supported') return true;
        if (cmd === 'is_fullscreen_active') return false;
        if (cmd === 'plugin:event|listen') return 1;
        return null;
      },
    };
  }, panel);
  await page.goto(base);
  await page.locator('[data-workbench-summary]').waitFor();
  await page.locator('[data-hit="true"]').first().click();
  const tabs = page.locator('[data-agent-app-tabs]');
  await tabs.waitFor();
  await page.waitForTimeout(500);
  assert.equal(await tabs.getByRole('button').count(), 2);
  assert.equal(await tabs.locator('[data-agent-filter="all"], [data-agent-filter="unassigned"]').count(), 0);
  assert.equal(await tabs.locator('[data-connected="true"]').count(), 2);
  assert.ok(!(await page.locator('[data-island-controls]').innerText()).includes('任务岛'));
  const header = await page.locator('[data-agent-panel-header]').boundingBox(), list = await page.locator('[data-workbench-routes]').boundingBox();
  assert.ok(header.y + header.height <= list.y + 1);
  const cards = page.locator('.wb-route-card');
  const total = await cards.count(); assert.ok(total > 2);
  await page.screenshot({ path: path.join(output, 'all-applications.png') });
  report.checks.push('Original-style pills above panel, title removed, two independent live dots');
  await tabs.locator('[data-agent-filter="codex"]').click();
  await page.waitForTimeout(350);
  assert.equal(await cards.count(), 1);
  await page.screenshot({ path: path.join(output, 'codex-filter.png') });
  await tabs.locator('[data-agent-filter="claude-code"]').click(); await page.waitForTimeout(350);
  assert.equal(await cards.count(), 1);
  assert.equal(await tabs.locator('[data-agent-filter="workbuddy"], [data-agent-filter="dsh"]').count(),0);
  assert.match(await tabs.locator('[data-agent-filter="codex"] img').getAttribute('src'),/openai.svg/);
  assert.match(await tabs.locator('[data-agent-filter="claude-code"] img').getAttribute('src'),/claude-color.svg/);
  await tabs.locator('[data-agent-filter="claude-code"]').click(); await page.waitForTimeout(350);

  await page.waitForFunction(expected => document.querySelectorAll(".wb-route-card").length === expected, total);
  assert.equal(await cards.count(), total);
  assert.equal(await tabs.locator('[aria-pressed="true"]').count(), 0);
  report.checks.push('Only real applications have pills; clicking the selected app again restores all tasks including unassigned history');
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} finally {
  await browser?.close(); server.kill();
  await writeFile(path.join(output,'browser.json'),JSON.stringify(report,null,2)+'\n','utf8');
  console.log(JSON.stringify(report));
}



