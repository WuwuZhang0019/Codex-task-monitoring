// Date: 2026-11-13. Browser-only polling test: new plan appears without opening the panel.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';
const bundle=await build({stdin:{contents:"export {createScenario} from './fixtures'",resolveDir:new URL('../contracts/island-workbench-v1/',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),loader:'ts'},bundle:true,format:'esm',platform:'node',write:false});
const {createScenario}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const snapshot=createScenario('multi-project').snapshot;snapshot.mode='service';snapshot.revision=1;
for(const group of ['projects','plans','steps','routes','bindings','executions','supplements'])for(const item of snapshot[group])item.id=item.key+'/real';
const newer=structuredClone(snapshot);newer.revision=2;
newer.projects[0].planKeys.unshift('new-plan');
newer.plans.unshift({...newer.plans[0],key:'new-plan',id:'new-plan-id',name:'New automatic focus',stageKeys:['new-step'],stageCount:1});
newer.steps.unshift({...newer.steps[0],key:'new-step',id:'new-step-id',planKey:'new-plan',code:'Z',dependsOn:[],status:'pending',bindingKey:null,executionKey:null});
newer.routes.unshift({...newer.routes[0],key:'new-route',id:'new-route-id',planKey:'new-plan',stepKeys:['new-step'],sourceStepKey:null,returnStepKey:null});
let active=snapshot;
let preferences={collapsed:[],selected:snapshot.steps[0].key,focus:[snapshot.routes[0].key],scroll:{},y:{}};
const server=spawn('G:/rust/Codex-task-monitoring/app/test-results/island-A-tools/node_modules/bun/bin/bun.exe',['node_modules/vite/bin/vite.js','preview','--port','1473','--strictPort'],{cwd:'G:/rust/windows-dynamic-island',windowsHide:true,stdio:'pipe'});
let browser;
try{
 for(let i=0;i<60;i++){try{if((await fetch('http://localhost:1473')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const page=await browser.newPage({viewport:{width:1100,height:820}});page.setDefaultTimeout(7000);
 await page.exposeBinding('newTaskBridge',async(_source,command,args)=>{
  if(command==='island_workbench_read')return {snapshot:active,preferences,library:{version:1,archived:[]}};
  if(command==='island_workbench_save_preferences'){preferences=args.value;return {saved:true};}
  throw Error('Unexpected command');
 });
 await page.goto('http://localhost:1473');
 await page.locator('[data-workbench-summary]').waitFor();
 await page.evaluate(()=>{window.__TAURI_INTERNALS__={invoke:(command,args)=>window.newTaskBridge(command,args)};});
 await page.waitForFunction(()=>document.querySelector('[data-workbench-summary]')?.getAttribute('data-connection')==='ready');
 active=newer;
 await page.waitForFunction(()=>document.querySelector('[data-workbench-summary] .wb-mini-route')?.getAttribute('data-route-key')==='new-route');
 await page.locator('[data-hit]').first().click();
 assert.equal(await page.locator('[data-route-card]').first().getAttribute('data-route-card'),'new-plan');
 await page.locator('[data-route-card="sim/plan/main"] .wb-route-body .wb-group-graph').click({position:{x:60,y:35}});
 await page.waitForTimeout(2200);
 await page.mouse.click(20,800);
 await page.waitForTimeout(500);
 assert.notEqual(await page.locator('[data-workbench-summary] .wb-mini-route').getAttribute('data-route-key'),'new-route');
 const execution=structuredClone(newer);execution.revision=3;
 execution.steps.find(step=>step.key==='new-step').status='running';
 execution.events.push({eventId:'execution-start',stepKey:'new-step',executionKey:null,reason:'Actual start',occurredAt:'2026-11-13T01:00:00Z',receivedAt:'2026-11-13T01:00:00Z',toStatus:'running'});
 active=execution;
 await page.waitForFunction(()=>document.querySelector('[data-workbench-summary] .wb-mini-route')?.getAttribute('data-route-key')==='new-route');
 await page.locator('[data-hit]').first().click();
 await page.locator('[data-route-card="sim/plan/main"] .wb-route-body .wb-group-graph').click({position:{x:60,y:35}});
 await page.mouse.click(20,800);await page.waitForTimeout(500);
 const fast=structuredClone(execution);fast.revision=4;
 fast.steps.find(step=>step.key==='new-step').status='completed';
 fast.events.push({eventId:'fast-new-start',stepKey:'new-step',executionKey:null,reason:'Start before next poll',occurredAt:'2026-11-13T01:00:01Z',receivedAt:'2026-11-13T01:00:01Z',toStatus:'running'});
 active=fast;
 await page.waitForFunction(()=>document.querySelector('[data-workbench-summary] .wb-mini-route')?.getAttribute('data-route-key')==='new-route');
 await mkdir('test-results/new-task-focus',{recursive:true});await page.screenshot({path:'test-results/new-task-focus/browser.png'});
 await writeFile('test-results/new-task-focus/report.json',JSON.stringify({date:'2026-11-13',native:false,checks:['collapsed island follows new plan without clicking','new plan is first in expanded list','manual selection survives subsequent polls','existing plan execution switches collapsed route','fast execution between polls switches route']},null,2));
 console.log('5 browser checks passed');
}finally{await browser?.close();server.kill();}
