// 日期：2026-11-13。浏览器验证模式设置、持久化、原生控制参数及连续执行反馈；调度另由服务测试验证。
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';
const bundle=await build({stdin:{contents:"export {createScenario} from './fixtures'",resolveDir:new URL('../contracts/island-workbench-v1/',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),loader:'ts'},bundle:true,format:'esm',platform:'node',write:false});
const {createScenario}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const snapshot=createScenario('multi-project').snapshot;snapshot.mode='service';snapshot.revision=1;
for(const group of ['projects','plans','steps','routes','bindings','executions','supplements'])for(const item of snapshot[group])item.id=item.key+'/real';
for(const project of snapshot.projects)project.revision=1;
let runs=[],preferences={collapsed:[],selected:snapshot.steps[0].key,focus:[snapshot.routes[0].key],scroll:{},y:{}};
const actions=[],modeRequests=[];let rejectNext=false,holdNext=false,release;
const server=spawn('G:/rust/Codex-task-monitoring/app/test-results/island-A-tools/node_modules/bun/bin/bun.exe',['node_modules/vite/bin/vite.js','preview','--port','1474','--strictPort'],{cwd:'G:/rust/windows-dynamic-island',windowsHide:true,stdio:'pipe'});
let browser;
try{
 for(let i=0;i<60;i++){try{if((await fetch('http://localhost:1474')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const context=await browser.newContext({viewport:{width:1100,height:820}}),page=await context.newPage();page.setDefaultTimeout(7000);
 await page.exposeBinding('continuousBridge',async(_source,command,args)=>{
  if(command==='island_workbench_read')return {snapshot,preferences,continuousRuns:runs,continuousSupported:true,library:{version:1,archived:[]}};
  if(command==='island_workbench_save_preferences'){preferences=args.value;return {saved:true};}
  if(command==='island_continuous_change'){
   const {action,mode}=args.value;
   assert.deepEqual(Object.keys(args.value).sort(),action==='pause'?['acknowledged','action','expectedRevision','planKey']:['acknowledged','action','expectedRevision','mode','planKey']);
   assert.equal(args.value.acknowledged,true);assert.equal(args.value.expectedRevision,1);
   if(action!=='pause')assert.ok(['stages','current_thread'].includes(mode));
   actions.push(action);modeRequests.push({action,mode:mode??null});
   if(rejectNext){rejectNext=false;throw Error('SOURCE_CHANGED: 方案原文已变化，请核对并重新登记版本');}
   if(holdNext){holdNext=false;await new Promise(resolve=>{release=resolve;});}
   runs=[{id:'run',planKey:args.value.planKey,status:action==='pause'?'pausing':'running',enabled:action!=='pause',mode:mode??runs[0]?.mode??'stages',phase:action==='pause'?null:'executing',stageCode:'B',threadId:'real-chat-from-service',reason:'',completed:1,total:3}];return{saved:true};
  }
  throw Error('Unexpected command '+command);
 });
 async function connect(){
  await page.bringToFront();
  await page.goto('http://localhost:1474');await page.locator('[data-workbench-summary]').waitFor();
  await page.evaluate(()=>{window.__TAURI_INTERNALS__={invoke:(command,args)=>window.continuousBridge(command,args)};});
  await page.waitForFunction(()=>document.querySelector('[data-workbench-summary]')?.getAttribute('data-connection')==='ready');
  await page.locator('[data-hit]').first().click();
 }
 await connect();
 const button=page.getByRole('switch',{name:/连续执行：/}).first();await button.waitFor();
 assert.equal(await button.textContent(),'连续执行');assert.equal(await button.getAttribute('aria-checked'),'false');
 await page.waitForTimeout(700);const size=await button.evaluate(b=>({width:getComputedStyle(b).width,height:getComputedStyle(b).height}));assert.equal(size.width,'102px');assert.equal(size.height,'28px');
 assert.equal(await button.evaluate(b=>b.nextElementSibling?.getAttribute('aria-label')?.startsWith('归档：')),true);
 await mkdir('test-results/continuous-button',{recursive:true});await page.screenshot({path:'test-results/continuous-button/off.png'});
 holdNext=true;await button.click();await page.waitForFunction(()=>document.querySelector('.wb-continuous')?.getAttribute('aria-busy')==='true');assert.match(await button.textContent(),/处理中/);release();
 await page.waitForFunction(()=>document.querySelector('.wb-continuous')?.getAttribute('aria-checked')==='true');
 assert.equal(modeRequests[0].mode,'stages');
 await page.waitForTimeout(500);assert.equal(await button.evaluate(b=>getComputedStyle(b).backgroundColor),'rgb(138, 92, 212)');await page.screenshot({path:'test-results/continuous-button/on.png'});
 const press=await button.boundingBox();await page.mouse.move(press.x+45,press.y+14);await page.mouse.down();await page.mouse.move(press.x+55,press.y+14,{steps:4});await page.mouse.up();await page.waitForFunction(()=>document.querySelector('.wb-continuous')?.getAttribute('data-status')==='pausing');
 assert.equal(await button.getAttribute('aria-checked'),'false');assert.equal(await button.isDisabled(),false);assert.match(await button.getAttribute('title'),/当前阶段完成后暂停/);
 await page.waitForTimeout(500);assert.equal(await button.evaluate(b=>getComputedStyle(b).backgroundColor),'rgb(49, 48, 51)');await page.screenshot({path:'test-results/continuous-button/pausing.png'});
 await button.click();await page.waitForFunction(()=>document.querySelector('.wb-continuous')?.getAttribute('aria-checked')==='true');
 await button.click();await page.waitForFunction(()=>document.querySelector('.wb-continuous')?.getAttribute('data-status')==='pausing');
 runs[0].status='paused';runs[0].enabled=false;await page.waitForFunction(()=>document.querySelector('.wb-continuous')?.getAttribute('data-status')==='paused'&&!document.querySelector('.wb-continuous')?.disabled);
 await button.click();await page.waitForFunction(()=>document.querySelector('.wb-continuous')?.getAttribute('aria-checked')==='true');
 assert.deepEqual(actions,['start','pause','resume','pause','resume']);
 assert.ok(modeRequests.filter(x=>x.action!=='pause').every(x=>x.mode==='stages'));
 runs[0].phase='waiting';await page.getByText('已开启，等待当前阶段验收通过后接续',{exact:true}).waitFor();
 runs[0].status='completed';await page.waitForFunction(()=>document.querySelector('.wb-continuous')?.disabled);
 assert.equal(await button.textContent(),'已完成');assert.equal(await button.getAttribute('aria-checked'),'false');
 await page.screenshot({path:'test-results/continuous-button/completed.png'});
 const settings=await context.newPage();await settings.setViewportSize({width:860,height:620});await settings.goto('http://localhost:1474/#settings');
 await settings.getByRole('link',{name:'连续执行',exact:true}).click();
 assert.equal(await settings.getByRole('radio',{name:/阶段完成后接续新会话/}).isChecked(),true);
 await settings.getByRole('radio',{name:/立即通知当前会话持续执行/}).check();
 assert.equal(await settings.evaluate(()=>JSON.parse(localStorage.getItem('island-workbench-settings-v1'))['tasks.continuousMode']),'current_thread');
 await settings.reload();await settings.getByRole('link',{name:'连续执行',exact:true}).click();
 assert.equal(await settings.getByRole('radio',{name:/立即通知当前会话持续执行/}).isChecked(),true);
 assert.match(await settings.locator('main').textContent(),/下次开启、恢复或重试时使用/);
 await settings.waitForTimeout(500);await settings.screenshot({path:'test-results/continuous-button/two-mode-settings.png'});
 runs=[];await connect();
 await button.click();await page.waitForFunction(()=>document.querySelector('.wb-continuous')?.getAttribute('aria-checked')==='true');assert.equal(modeRequests.at(-1).mode,'current_thread');
 runs[0].status='blocked';runs[0].reason='工作目录不存在，请先恢复方案登记的目录';
 await page.waitForFunction(()=>document.querySelector('.wb-continuous')?.getAttribute('data-status')==='blocked');
 assert.equal(await button.getAttribute('aria-checked'),'true');assert.equal(await button.textContent(),'接续受阻');
 await page.getByText(/接续受阻：工作目录不存在/).waitFor();await page.waitForTimeout(500);assert.equal(await button.evaluate(b=>getComputedStyle(b).backgroundColor),'rgb(134, 96, 38)');await page.screenshot({path:'test-results/continuous-button/blocked.png'});
 await page.getByRole('button',{name:'重试',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.wb-continuous')?.getAttribute('data-status')==='running');
 assert.deepEqual(modeRequests.at(-1),{action:'resume',mode:'current_thread'});
 runs[0].status='blocked';runs[0].reason='方案需要不同工作树，请切换为阶段接续';await page.waitForFunction(()=>document.querySelector('.wb-continuous')?.getAttribute('data-status')==='blocked');
 await button.click();await page.waitForFunction(()=>document.querySelector('.wb-continuous')?.getAttribute('aria-checked')==='false');assert.deepEqual(modeRequests.at(-1),{action:'pause',mode:null});
 rejectNext=true;await button.click();await page.getByText(/连续执行未启动：.*SOURCE_CHANGED: 方案原文已变化/).waitFor();
 assert.equal(await button.getAttribute('aria-checked'),'false');assert.equal(await button.isDisabled(),false);
 await page.screenshot({path:'test-results/continuous-button/preflight-error.png'});
 await settings.getByRole('radio',{name:/阶段完成后接续新会话/}).check();await settings.reload();await settings.getByRole('link',{name:'连续执行',exact:true}).click();assert.equal(await settings.getByRole('radio',{name:/阶段完成后接续新会话/}).isChecked(),true);
 await connect();await button.click();await page.waitForFunction(()=>document.querySelector('.wb-continuous')?.getAttribute('aria-checked')==='true');assert.deepEqual(modeRequests.at(-1),{action:'resume',mode:'stages'});
 const checks=['102 by 28 button before archive','busy request feedback','default stages on start and resume','draining stage immediately displays gray switch','drag isolation and repeated pause/resume','completed label disables repeated dispatch','waiting message visible without hover','both mode selections persist after settings reload','current-thread mode passed on start and retry','blocked retains enabled intent with visible reason and retry','blocked switch explicitly pauses without sending a new mode','preflight rejection stays off with persistent exact reason','settings switch to stages applies on next resume'];
 await writeFile('test-results/continuous-button/browser-report.json',JSON.stringify({date:'2026-11-13',native:false,realModel:false,actions,modeRequests,checks},null,2));console.log(checks.length+' continuous button browser checks passed');
}finally{release?.();await browser?.close();server.kill();}
