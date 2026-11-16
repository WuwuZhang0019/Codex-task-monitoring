// 日期：2026-11-16。浏览器+真实隔离领域服务；仅桥接 WebView 传输，不写生产数据。
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from '@playwright/test';
import {createPersistence} from '../server/persistence.mjs';
import {createRequests} from '../server/business-requests.mjs';
import {createLightService} from '../server/light-service.mjs';
import {createLightAccess} from '../server/light-access.mjs';
import {createLightPublication} from '../server/light-publication.mjs';
import {prepareLightPlan} from '../server/light-import.mjs';
import {createLightHandler} from '../mcp/light.mjs';
import {buildGrowingRouteRevision} from '../../plugins/task-workbench/skills/workbench-handoff/scripts/growing-route.mjs';

const shell=process.env.ISLAND_SHELL_ROOT;
if(!shell||!path.isAbsolute(shell))throw Error('ISLAND_SHELL_ROOT must name the isolated shell checkout');
const {preview}=await import(pathToFileURL(path.join(shell,'node_modules/vite/dist/node/index.js')));
const root=await mkdtemp(path.join(os.tmpdir(),'growing-browser-'));
const output=path.resolve('test-results/growing-routes');await mkdir(output,{recursive:true});
const p=await createPersistence(root),access=createLightAccess(p),{principal}=await access.connect({acknowledged:true});
const service=createLightService(p,createRequests(p),{authorize:access.authorize,automaticBinding:access.automaticBinding,verifyExecutionContext:access.verifyExecutionContext});
const publisher=createLightPublication(p,createRequests(p),service,{authorize:access.authorize,automaticPublication:access.automaticPublication});
const handler=createLightHandler({service,authenticate:()=>principal,publish:publisher.publish});
const context={sessionGroup:'fixture',threadId:'fixture-browser',hostId:'local',folderId:null,worktreeOrdinal:1,worktreePath:root,branch:null,head:null,trust:'declared'};
const candidate=prepareLightPlan({text:'# 动态路线隔离演示\n日期：2026-11-16\n## 实施路线与出口\n| 阶段 | 前置 | 范围 | 出口 |\n| A 服务线 | 无 | 实际步骤逐项明确 | 必要验收通过 |\n| B 集成线 | 无 | 实际步骤逐项明确 | 必要验收通过 |\n',sourcePath:path.join(root,'plan.md'),version:'fixture-1',projectKey:'browser/growing',planKey:'browser/growing/plan',name:'动态路线隔离演示',date:'2026-11-16',context});
candidate.routes=candidate.steps.map((step,i)=>({...candidate.routes[0],key:'route/'+step.code,label:step.title,order:i+1,stepKeys:[step.key]}));
const {trust,...source}=candidate.plans[0].source;
const reg=await publisher.publish(principal,'register',{schemaVersion:'light-1.0',eventId:'register',expectedRevision:0,source,occurredAt:new Date().toISOString(),snapshot:candidate,confirmationGrant:null});
const read=()=>service.read(principal,reg.projectId);
const base=eventId=>({schemaVersion:'light-1.0',projectId:reg.projectId,planId:reg.planIds[0],expectedRevision:read().projects[0].revision,eventId,source,occurredAt:new Date().toISOString(),reason:'隔离演示验收'});
const proof=(result='passed')=>({evidenceId:'fixture-proof',location:'fixture://browser-check',method:'自动化隔离检查，不是真实项目证据',deliveryVersion:'fixture-v1',result});
async function grow(taskKey,extra={}){
 const change=buildGrowingRouteRevision(read(),{planId:reg.planIds[0],headingKey:candidate.steps[0].key,taskKey,title:'实际步骤 '+taskKey,acceptance:'定向断言通过',sourceLocator:'fixture-turn/'+taskKey,eventId:'grow/'+taskKey,reason:'隔离演示实际步骤',...extra});
 if(change.request){const result=(await handler.callTool({params:{name:'workbench_revise_plan',arguments:change.request}})).structuredContent;assert.equal(result.status,'accepted',JSON.stringify(result.error));}
 return change;
}
let override=null;
let preferences={collapsed:[],selected:read().steps[0].key,focus:[read().routes[0].key],scroll:{},y:{}};
const server=await preview({root:shell,configFile:false,preview:{host:'127.0.0.1',port:1492,strictPort:true}});
let browser;
const report={date:'2026-11-17',native:false,transport:'browser bridge to real isolated domain service and MCP handler',checks:[],screenshots:[]};
try{
 browser=await chromium.launch({headless:true,channel:'msedge'});
 async function pageFor(size){
  const page=await browser.newPage({viewport:{width:1100,height:820},locale:'zh-CN',reducedMotion:'reduce'});page.setDefaultTimeout(10000);
  await page.addInitScript(value=>localStorage.setItem('island-workbench-settings-v1',JSON.stringify({'shell.configVersion':1,'app.language':'zh-CN','appearance.style':'windows','island.openOn':'click','tasks.displaySize':value,'tasks.cardEffect':'minimal'})),size);
  await page.exposeBinding('growingBridge',async(_source,command,args)=>{
   if(command==='island_workbench_read')return {snapshot:override??read(),preferences,library:{version:1,archived:[]}};
   if(command==='island_workbench_save_preferences'){preferences=args.value;return {saved:true};}
   throw Error('Unexpected fixture command: '+command);
  });
  await page.goto('http://127.0.0.1:1492');await page.locator('[data-workbench-summary]').waitFor();
  await page.evaluate(()=>{window.__TAURI_INTERNALS__={invoke:(command,args)=>window.growingBridge(command,args)};});
  await page.waitForFunction(()=>document.querySelector('[data-workbench-summary]')?.getAttribute('data-connection')==='ready');
  await page.locator('[data-hit]').first().click();
  await page.locator('[data-route-card]').first().waitFor();
  await page.getByTitle('固定展开',{exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-hit]')?.getBoundingClientRect().height>300);
  await page.waitForTimeout(800);
  return page;
 }
 async function snap(page,name){const file=path.join(output,name+'.png');await page.screenshot({path:file,fullPage:true});report.screenshots.push(file);}
 async function assertLeft(page){
  const positions=await page.locator((await page.locator('[data-workbench]').getAttribute('data-task-size'))==='large' ? '[data-route-card] .wb-route-body [data-graph-renderer]' : '[data-route-card] .wb-route-heading [data-graph-renderer]').first().evaluate(graph=>({left:graph.getBoundingClientRect().left,headings:[...graph.querySelectorAll('[data-heading="true"]')].map(n=>{const r=n.getBoundingClientRect();return r.x+r.width/2;})}));
  assert.equal(positions.headings.length,2);assert.ok(positions.headings.every(x=>Math.abs(x-positions.left)<2),JSON.stringify(positions));
 }
 const page=await pageFor('small');await assertLeft(page);await snap(page,'01-headings-left');
 report.checks.push('heading-only routes appear at the left before any actual work');
 const past=await grow('历史已验收',{history:{status:'completed',evidence:[proof()],occurredAt:null}});
 const unknown=await grow('历史待核验',{headingKey:candidate.steps[1].key,dependsOn:[past.stepKey],history:{status:'pending',evidence:[proof('pending')],occurredAt:null}});
 const current=await grow('当前工作');
 const bound=await service.bind(principal,{...base('bind'),action:'propose',stepIds:[read().steps[0].id],context,bindingId:null,expectedBindingRevision:null,confirmationGrant:null});
 async function start(key){const step=read().steps.find(s=>s.key===key),executionId=(await service.reserveExecutionId(principal,base('reserve-'+step.code))).executionId;
  await service.update(principal,{...base('start-'+step.code),bindingId:bound.bindingId,bindingRevision:bound.bindingRevision,executionId,stepId:step.id,targetStatus:'running',checks:[],evidence:[],blocker:null,reopen:null,successorImpact:null});return executionId;}
 await start(read().steps[0].key);const executionId=await start(current.stepKey);
 await page.waitForFunction(key=>document.querySelector(`[data-graph-renderer] [data-step-key="${key}"]`)?.getAttribute('data-status')==='running',current.stepKey);
 await assertLeft(page);await snap(page,'02-history-and-current');
 assert.equal(read().executions.length,2,'only genuinely started header and actual step have executions');
 const retry=await grow('当前工作');assert.equal(retry.outcome,'reused');assert.equal(read().steps.length,5);
 report.checks.push('verified history, pending review and live work share growing horizontal routes','retries reuse one node and historical entries have no invented executions');
 const step=read().steps.find(s=>s.key===current.stepKey);
 await service.update(principal,{...base('finish-current'),bindingId:bound.bindingId,bindingRevision:bound.bindingRevision,executionId,stepId:step.id,targetStatus:'completed',checks:step.conditions.map(c=>({...c,result:'passed',evidenceIds:['fixture-proof']})),evidence:[proof()],blocker:null,reopen:null,successorImpact:null});
 const next=await grow('下一实际工作');assert.equal(read().steps[0].status,'running');
 await page.waitForFunction(key=>!!document.querySelector(`[data-graph-renderer] [data-step-key="${key}"]`),next.stepKey);
 const phase=await grow('责任包内阶段',{headingKey:next.stepKey});
 await page.waitForFunction(key=>!!document.querySelector(`[data-graph-renderer] [data-step-key="${key}"]`),phase.stepKey);
 assert.equal(read().steps.find(step=>step.key===phase.stepKey).parentKey,next.stepKey);
 report.checks.push('registered phases nested under an existing work package appear as separate stations');
 for(const width of [1100,820,480]){await page.setViewportSize({width,height:820});await assertLeft(page);await snap(page,'03-grown-'+width);}
 report.checks.push('completion updates the original node; another real step grows the line without blocking its running heading','compact origins stay left at 1100, 820 and 480 px');
 await page.close();
 const expanded=await pageFor('large');await assertLeft(expanded);
 assert.match(await expanded.locator(`.wb-route-body [data-graph-renderer] [data-step-key="${unknown.stepKey}"]`).getAttribute('title'),/待核验/);
 assert.ok(await expanded.locator('[data-kind="dependency"]').count()>0);await snap(expanded,'04-expanded');
 report.checks.push('expanded view retains cross-line dependencies and shows unverified history explicitly');
 await expanded.close();
 if(process.env.GROWING_READONLY_SNAPSHOT){
  override=JSON.parse(await readFile(process.env.GROWING_READONLY_SNAPSHOT,'utf8'));
  preferences={collapsed:[],selected:override.steps[0].key,focus:[override.routes[0].key],scroll:{},y:{}};
  const real=await pageFor('small');
  const nodeCount=await real.locator('[data-route-card] .wb-route-heading [data-graph-renderer] [data-step-key]').count();
  assert.equal(nodeCount,override.steps.length);await snap(real,'05-readonly-project-copy');
  report.checks.push(`read-only project copy expands all ${nodeCount} registered nodes without modifying original data`);await real.close();
 }
 await writeFile(path.join(output,'service-snapshot.json'),JSON.stringify(read(),null,2)+'\n','utf8');
 await writeFile(path.join(output,'cli-options.json'),JSON.stringify({planId:reg.planIds[0],headingKey:read().steps[0].key,taskKey:'offline-cli-check',title:'隔离CLI检查',acceptance:'参数校验通过',sourceLocator:'fixture://cli',eventId:'offline-cli',reason:'仅离线验证'},null,2)+'\n','utf8');
 await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n','utf8');console.log(JSON.stringify(report));
}finally{await browser?.close();await new Promise(r=>server.httpServer.close(r));await rm(root,{recursive:true,force:true});}
