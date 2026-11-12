// Date: 2026-11-13. Real Edge UI; controlled native panel data, without changing production authorization.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const root = process.env.ISLAND_SHELL_ROOT ?? 'G:/rust/windows-dynamic-island';
const output = path.resolve('test-results/archived-compact');
const bun = path.resolve('test-results/island-A-tools/node_modules/bun/bin/bun.exe');
const base = 'http://localhost:1469';
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
panel.library.archived=[{key:first.key,archivedAt:'2026-11-13T00:00:00Z'}];
const server = spawn(bun, ['node_modules/vite/bin/vite.js','preview','--port','1469','--strictPort'], { cwd: root, windowsHide: true, stdio: 'pipe' });
await mkdir(output, { recursive: true });
let browser;
const report = { date: '2026-11-13', environment: 'Edge UI with controlled native panel substitute', checks: [], pageErrors: [] };
try {
  for (let i=0;i<80;i++) { try { if ((await fetch(base)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve,100)); }
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 }, locale: 'zh-CN' });
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.addInitScript(data => {
    window.__agentPanel = data;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'settings' }, currentWebview: { label: 'settings' } },
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke: async (cmd,args) => {
        if(cmd==='island_task_library_read') return window.__agentPanel;
        if(cmd==='island_task_library_change'){window.__changes??=[];window.__changes.push(args);window.__agentPanel.library.archived=[];return {saved:true,revision:2};}
        if (cmd === 'get_settings') return { 'app.language':'zh-CN','shell.configVersion':1,'appearance.style':'windows','island.openOn':'click','island.closeOn':'clickOutside' };
        if (cmd === 'island_workbench_read') return window.__agentPanel;
        if (cmd === 'glass_supported') return true;
        if (cmd === 'is_fullscreen_active') return false;
        if (cmd === 'plugin:event|listen') return 1;
        return null;
      },
    };
  }, panel);
  await page.goto(`${base}/#settings`);
  await page.locator('nav').getByText('已归档任务',{exact:true}).click();
  const row=page.locator('[data-archived-task]'); await row.waitFor();
  assert.equal(await page.getByRole('heading',{name:'已归档任务',exact:true}).count(),1);
  assert.ok(await row.locator('.wb-group-graph-compact .wb-step').count()>0);
  assert.equal(await row.getByRole('button',{name:/归档：/}).count(),0);
  await page.screenshot({path:path.join(output,'archived-compact.png')});
  await row.getByRole('button',{name:/删除：/}).click();
  await page.getByRole('alertdialog').waitFor();
  assert.equal(await page.evaluate(()=>window.__changes?.length??0),0);
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await row.getByRole('button',{name:/恢复：/}).click();
  await page.getByText('暂无已归档任务。',{exact:false}).waitFor();
  assert.equal(await page.evaluate(()=>window.__changes.at(-1).action),'restore');
  report.checks.push('Archived page renamed; compact graph rendered; restore works and deletion requires explicit confirmation; controlled native substitute only');
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} finally {
  await browser?.close(); server.kill();
  await writeFile(path.join(output,'browser.json'),JSON.stringify(report,null,2)+'\n','utf8');
  console.log(JSON.stringify(report));
}




