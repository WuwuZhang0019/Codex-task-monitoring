// 日期：2026-11-12。真实安装版WebView/原生桥验收；CDP输入与物理OS输入分开记录。
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { spawnSync,spawn } from 'node:child_process';
import path from 'node:path';
const base='G:/rust/Codex-task-monitoring';
const out=path.join(base,'docs/03_轻量路线工作台/06_执行记录/island-workbench-20261111/assets/E/continuation');
await mkdir(out,{recursive:true});
const report={date:'2026-11-12',nativeInstalled:true,installedHash:'BA112BB56C228DA9B7922EBA3E30DFF58C4E16D42EB61BB5B6347C4131C5736E',transport:'loopback WebView2 CDP; noDefaults=true; real Tauri commands/OS foreground diagnostics; hover bus cases explicitly controlled event, not OS physical mouse',checks:[],errors:[],limitations:['CDP screenshots are native WebView-only and exclude native glass','No business step transitions or grants; reading preference writes only','Physical mouse hover and OS hit testing remain separate']};
const browser=await chromium.connectOverCDP('http://127.0.0.1:19226',{noDefaults:true});
const pages=browser.contexts().flatMap(c=>c.pages());let island,settings;
for(const p of pages){if(p.url().startsWith('http://tauri.localhost')){if(await p.locator('[data-workbench-summary],[data-workbench]').count())island=p;else if(await p.getByRole('link',{name:'外观',exact:true}).count())settings=p;}}
assert.ok(island&&settings,'native island/settings pages required');
island.setDefaultTimeout(6000);settings.setDefaultTimeout(6000);
island.on('pageerror',e=>report.errors.push(String(e)));
const invoke=(cmd,args)=>island.evaluate(({cmd,args})=>window.__TAURI_INTERNALS__.invoke(cmd,args),{cmd,args});
const hover=inside=>invoke('plugin:event|emit',{event:'island://hover',payload:inside});
const height=async()=> (await island.locator('[data-hit]').boundingBox())?.height??0;
const open=async()=>{await hover(false);await island.waitForTimeout(120);await hover(true);await island.waitForFunction(()=>document.querySelector('[data-workbench]'),null,{polling:100,timeout:6000});await island.waitForTimeout(750);};
const state=()=>{const r=spawnSync('pwsh',['-NoProfile','-File',path.join(base,'app/test-results/island-E/continuation/read-native-state.ps1')],{encoding:'utf8',windowsHide:true});if(r.status!==0)throw Error(r.stderr);return JSON.parse(r.stdout.trim().replace(/^\uFEFF/,''));};
const check=async(name,fn)=>{try{const detail=await fn();report.checks.push({name,result:'passed',detail});}catch(e){report.checks.push({name,result:'failed',error:String(e.stack)});report.errors.push(name);}finally{console.log(JSON.stringify(report.checks.at(-1)));await writeFile(path.join(out,'native-webview-progress_2026-11-12.json'),JSON.stringify(report,null,2));}};
try{
 await settings.getByRole('link',{name:'外观',exact:true}).click();
 for(const [style,label] of [['dynamic',/^刘海模式/],['windows',/Windows 灵动岛 \(Windows Island\)/]]){
 await check(`${style}: native setting persistence and geometry`,async()=>{
  await settings.getByRole('button',{name:label}).click();
  await settings.waitForTimeout(450);
  const saved=JSON.parse(await readFile('C:/Users/Zyf/AppData/Roaming/com.wuwuzhang0019.islandworkbench/settings.json','utf8'));
  assert.equal(saved['appearance.style'],style);assert.equal(saved['appearance.glass'],'strong');
  await island.keyboard.press('Escape');await hover(false);await island.waitForTimeout(900);
  const compact=await island.locator('[data-hit]').boundingBox();assert.ok(compact.height<60);
  await open();const expanded=await island.locator('[data-hit]').boundingBox();assert.ok(expanded.height>300&&expanded.height<640);
  await island.screenshot({path:path.join(out,`${style}-native-webview_2026-11-12.png`)});
  return {style,compact,expanded,glass:'strong unchanged'};
 });
 await check(`${style}: actual native focus and Enter/Tab/Esc`,async()=>{
  await open();await invoke('focus_island');const focused=state();assert.equal(focused.foreground.isEInstalled,true);
  const locate=island.getByRole('button',{name:'定位当前',exact:true});await locate.focus();await island.keyboard.press('Enter');
  const selected=await island.locator('[data-step-key][aria-pressed="true"]').first().getAttribute('data-step-key');assert.ok(selected);
  await island.getByRole('button',{name:'刷新',exact:true}).focus();await island.keyboard.press('Tab');
  const tag=await island.evaluate(()=>document.activeElement?.tagName);assert.equal(tag,'BUTTON');
  await island.keyboard.press('Escape');await hover(false);await island.waitForTimeout(1000);assert.ok(await height()<60);
  const afterEscape=state();return {focused,afterEscape,tabTarget:tag,selected};
 });
 await check(`${style}: controlled native hover events, pin and unpin`,async()=>{
  const before=state();await open();const after=state();assert.equal(after.foreground.handle,before.foreground.handle,'hover must not change OS foreground');
  await island.getByTitle('固定展开',{exact:true}).click();await hover(false);await island.waitForTimeout(1600);assert.ok(await height()>300);
  await island.getByTitle('取消固定',{exact:true}).click();await island.evaluate(()=>document.activeElement?.blur());await hover(false);await island.waitForTimeout(1600);assert.ok(await height()<60);
  for(let i=0;i<6;i++){await hover(true);await island.waitForTimeout(45);await hover(false);await island.waitForTimeout(45);}
  await island.waitForTimeout(1400);assert.ok(await height()<60);await open();assert.ok(await height()>300);
  return {method:'controlled event sent over real native event bus; physical mouse separate',before,after};
 });
 await check(`${style}: reading selection, scroll, refresh and locate`,async()=>{
  await open();await island.getByTitle('固定展开',{exact:true}).click();
  const steps=island.locator('[data-step-key]');assert.ok(await steps.count()>1);await steps.nth(1).click();
  const key=await steps.nth(1).getAttribute('data-step-key');assert.equal(await steps.nth(1).getAttribute('aria-pressed'),'true');
  const list=island.locator('[data-workbench-routes]');await list.evaluate(e=>e.scrollTop=200);const top=await list.evaluate(e=>e.scrollTop);
  await island.getByRole('button',{name:'刷新',exact:true}).click();await island.waitForTimeout(700);
  assert.equal(await list.evaluate(e=>e.scrollTop),top);assert.equal(await island.locator('[data-step-key][aria-pressed="true"]').first().getAttribute('data-step-key'),key);
  const lane=island.locator('[data-route-key]').first();await lane.evaluate(e=>e.scrollLeft=1000);const left=await lane.evaluate(e=>e.scrollLeft);await island.getByRole('button',{name:'刷新',exact:true}).click();await island.waitForTimeout(700);assert.equal(await lane.evaluate(e=>e.scrollLeft),left);
  await island.getByRole('button',{name:'定位当前',exact:true}).click();await island.waitForTimeout(250);assert.ok(await island.locator('[data-step-key][aria-pressed="true"]').count());
  await island.keyboard.press('Escape');await hover(false);await island.waitForTimeout(1000);
  return {selected:key,verticalRestored:top,horizontalRestored:left,nativeEditableInputs:await island.locator('input,textarea').count(),detailInput:'read-only product; no editable detail input to test'};
 });
 }
 await check('actual OS fullscreen detection and hide, then restore',async()=>{
  await invoke('focus_island');const beforeFullscreen=await invoke('is_fullscreen_active');assert.equal(beforeFullscreen,false);await invoke('set_setting',{key:'island.hideInFullscreen',value:true});await island.waitForTimeout(250);
  const child=spawn(path.join(base,'app/test-results/island-E/continuation/fullscreen-fixture.exe'),[],{windowsHide:true,stdio:'ignore'});
  const ended=new Promise(resolve=>child.once('exit',resolve));
  let active=false;for(let i=0;i<30;i++){if(await invoke('is_fullscreen_active')){active=true;break;}await island.waitForTimeout(100);}
  assert.ok(active,'real OS foreground fullscreen fixture must be detected');await island.waitForTimeout(600);
  const foreground=state();assert.equal(foreground.foreground.pid,child.pid);assert.equal(await island.locator('[data-hit]').count(),0,'hidden mode removes hit rect');
  await ended;await invoke('focus_island');await island.waitForTimeout(1400);assert.equal(await invoke('is_fullscreen_active'),false);
  await invoke('set_setting',{key:'island.hideInFullscreen',value:false});await island.waitForTimeout(500);assert.equal(await island.locator('[data-hit]').count(),1);
  return {foreground,fixturePid:child.pid,actualNativeFullscreen:true,restored:true};
 });
}finally{
 await invoke('set_setting',{key:'island.hideInFullscreen',value:false}).catch(()=>{});
 await invoke('set_setting',{key:'appearance.style',value:'windows'}).catch(()=>{});
 await island.keyboard.press('Escape').catch(()=>{});await hover(false).catch(()=>{});
 report.passed=report.errors.length===0;
 await writeFile(path.join(out,'native-webview-acceptance_2026-11-12.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({checks:report.checks.map(c=>({name:c.name,result:c.result,error:c.error})),passed:report.passed}));
 process.exit(report.passed?0:1);
}
