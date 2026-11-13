// 日期：2026-11-13。浏览器验证按钮位置、窄宽度和真实原生命令参数；调度另由服务与真实模型测试验证。
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
let runs=[],preferences={collapsed:[],selected:snapshot.steps[0].key,focus:[snapshot.routes[0].key],scroll:{},y:{}};const actions=[];
const server=spawn('G:/rust/Codex-task-monitoring/app/test-results/island-A-tools/node_modules/bun/bin/bun.exe',['node_modules/vite/bin/vite.js','preview','--port','1474','--strictPort'],{cwd:'G:/rust/windows-dynamic-island',windowsHide:true,stdio:'pipe'});
let browser;
try{
 for(let i=0;i<60;i++){try{if((await fetch('http://localhost:1474')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const page=await browser.newPage({viewport:{width:1100,height:820}});page.setDefaultTimeout(7000);
 await page.exposeBinding('continuousBridge',async(_source,command,args)=>{
  if(command==='island_workbench_read')return {snapshot,preferences,continuousRuns:runs,continuousSupported:true,library:{version:1,archived:[]}};
  if(command==='island_workbench_save_preferences'){preferences=args.value;return {saved:true};}
  if(command==='island_continuous_change'){
   assert.deepEqual(Object.keys(args.value).sort(),['acknowledged','action','expectedRevision','planKey']);assert.equal(args.value.acknowledged,true);assert.equal(args.value.expectedRevision,1);actions.push(args.value.action);
   runs=[{id:'run',planKey:args.value.planKey,status:args.value.action==='pause'?'pausing':'running',stageCode:'B',threadId:'real-chat-from-service',reason:'',completed:1,total:3}];return{saved:true};
  }
  throw Error('Unexpected command '+command);
 });
 await page.goto('http://localhost:1474');await page.locator('[data-workbench-summary]').waitFor();
 await page.evaluate(()=>{window.__TAURI_INTERNALS__={invoke:(command,args)=>window.continuousBridge(command,args)};});
 await page.waitForFunction(()=>document.querySelector('[data-workbench-summary]')?.getAttribute('data-connection')==='ready');
 await page.locator('[data-hit]').first().click();
 const button=page.getByRole('switch',{name:/连续执行：/}).first();await button.waitFor();
 assert.equal(await button.textContent(),'连续执行');assert.equal(await button.getAttribute('aria-checked'),'false');
 await page.waitForTimeout(700);const size=await button.evaluate(b=>({width:getComputedStyle(b).width,height:getComputedStyle(b).height}));assert.equal(size.width,'102px');assert.equal(size.height,'28px');
 const adjacent=await button.evaluate(b=>b.nextElementSibling?.getAttribute('aria-label')?.startsWith('归档：'));assert.equal(adjacent,true);
 await mkdir('test-results/continuous-button',{recursive:true});await page.screenshot({path:'test-results/continuous-button/off.png'});
 await button.click();await page.waitForFunction(()=>document.querySelector('.wb-continuous')?.getAttribute('aria-checked')==='true');
 await page.waitForTimeout(500);assert.equal(await button.evaluate(b=>getComputedStyle(b).backgroundColor),'rgb(138, 92, 212)');await page.screenshot({path:'test-results/continuous-button/on.png'});
 await button.click();await page.waitForFunction(()=>document.querySelector('.wb-continuous')?.getAttribute('data-status')==='pausing');
 assert.equal(await button.getAttribute('aria-checked'),'false');assert.equal(await button.isDisabled(),true);assert.match(await button.getAttribute('title'),/当前阶段完成后暂停/);
 await page.waitForTimeout(500);assert.equal(await button.evaluate(b=>getComputedStyle(b).backgroundColor),'rgb(49, 48, 51)');await page.screenshot({path:'test-results/continuous-button/pausing.png'});
 runs[0].status='paused';await page.waitForFunction(()=>document.querySelector('.wb-continuous')?.getAttribute('data-status')==='paused'&&!document.querySelector('.wb-continuous')?.disabled);
 await button.click();await page.waitForFunction(()=>document.querySelector('.wb-continuous')?.getAttribute('aria-checked')==='true');
 runs[0].status='completed';await page.waitForFunction(()=>document.querySelector('.wb-continuous')?.disabled);
 assert.deepEqual(actions,['start','pause','resume']);
 await writeFile('test-results/continuous-button/browser-report.json',JSON.stringify({date:'2026-11-13',native:false,actions,checks:['102 by 28 button before archive','fixed Chinese label','start invokes exact native control','draining stage immediately displays gray off switch and pause hint','pause and resume reflect service state','completed run disables repeated dispatch']},null,2));console.log('6 continuous button browser checks passed');
}finally{await browser?.close();server.kill();}
