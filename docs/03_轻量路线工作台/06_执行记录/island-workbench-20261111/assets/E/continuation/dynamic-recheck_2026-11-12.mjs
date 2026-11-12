// 日期：2026-11-12。仅重查首轮失败的刘海受控事件/阅读项，并补同会话Esc重开。
import assert from 'node:assert/strict';import {chromium} from 'playwright';import {writeFile,readFile} from 'node:fs/promises';import {spawnSync} from 'node:child_process';
const out='G:/rust/Codex-task-monitoring/docs/03_轻量路线工作台/06_执行记录/island-workbench-20261111/assets/E/continuation';
const b=await chromium.connectOverCDP('http://127.0.0.1:19226',{noDefaults:true});let p,s;
for(const q of b.contexts().flatMap(c=>c.pages())){if(await q.locator('[data-workbench-summary],[data-workbench]').count())p=q;else if(await q.getByRole('link',{name:'外观',exact:true}).count())s=q;}
p.setDefaultTimeout(6000);s.setDefaultTimeout(6000);
const inv=(cmd,args)=>p.evaluate(({cmd,args})=>window.__TAURI_INTERNALS__.invoke(cmd,args),{cmd,args});
const hover=v=>inv('plugin:event|emit',{event:'island://hover',payload:v});
const height=async()=> (await p.locator('[data-hit]').boundingBox())?.height??0;
const open=async()=>{await hover(false);await p.waitForTimeout(450);await hover(true);await p.waitForTimeout(1500);assert.ok(await p.locator('[data-workbench]').count());};
const state=()=>JSON.parse(spawnSync('pwsh',['-NoProfile','-File','G:/rust/Codex-task-monitoring/app/test-results/island-E/continuation/read-native-state.ps1'],{encoding:'utf8',windowsHide:true}).stdout.trim());
const r={date:'2026-11-12',nativeInstalled:true,style:'dynamic',checks:[],precondition:'fresh native WebView per independent scenario; no product source changes; focus settle before blur; controlled hover is not physical input'};
try{
 await s.getByRole('link',{name:'外观',exact:true}).click();await s.getByRole('button',{name:/^刘海模式/}).click();await p.waitForTimeout(350);
 await p.reload();await p.locator('[data-workbench-summary]').waitFor();await p.waitForTimeout(400);
 const before=state();await open();const after=state();assert.equal(after.foreground.handle,before.foreground.handle);
 await p.getByTitle('固定展开',{exact:true}).click();await p.waitForTimeout(350);await hover(false);await p.waitForTimeout(1500);assert.ok(await height()>300);
 await p.getByTitle('取消固定',{exact:true}).click();await p.waitForTimeout(350);await p.evaluate(()=>document.activeElement?.blur());await hover(false);await p.waitForTimeout(1600);assert.ok(await height()<60);
 for(let i=0;i<6;i++){await hover(true);await p.waitForTimeout(45);await hover(false);await p.waitForTimeout(45);}
 await p.waitForTimeout(1400);assert.ok(await height()<60);await open();assert.ok(await height()>300);r.checks.push({name:'native event hover/pin/unpin/rapid transitions',result:'passed',before,after});
 await p.reload();await p.locator('[data-workbench-summary]').waitFor();await p.waitForTimeout(400);await open();await p.getByTitle('固定展开',{exact:true}).click();await p.waitForTimeout(300);
 const steps=p.locator('[data-step-key]');await steps.nth(1).click();const key=await steps.nth(1).getAttribute('data-step-key');
 const list=p.locator('[data-workbench-routes]');await list.evaluate(e=>e.scrollTop=200);const top=await list.evaluate(e=>e.scrollTop);await p.getByRole('button',{name:'刷新',exact:true}).click();await p.waitForTimeout(750);assert.equal(await list.evaluate(e=>e.scrollTop),top);assert.equal(await p.locator('[data-step-key][aria-pressed="true"]').first().getAttribute('data-step-key'),key);
 await p.getByRole('button',{name:'定位当前',exact:true}).click();assert.ok(await p.locator('[data-step-key][aria-pressed="true"]').count());r.checks.push({name:'selection, scroll/refresh and locate',result:'passed',top});
 const cycles=[];
 for(let i=0;i<3;i++){await inv('focus_island');await p.getByRole('button',{name:'刷新',exact:true}).focus();await p.keyboard.press('Tab');await p.keyboard.press('Escape');await hover(false);await p.waitForTimeout(1500);assert.ok(await height()<60);await open();cycles.push({collapsedThenReopened:true,height:await height()});}
 r.checks.push({name:'same-session keyboard Esc/reopen three cycles',result:'passed',cycles});r.passed=true;
}catch(e){r.passed=false;r.error=String(e.stack);}finally{
 await inv('set_setting',{key:'appearance.style',value:'windows'});await p.keyboard.press('Escape');await hover(false);
 await writeFile(out+'/dynamic-native-recheck_2026-11-12.json',JSON.stringify(r,null,2));console.log(JSON.stringify(r));process.exit(r.passed?0:1);
}
