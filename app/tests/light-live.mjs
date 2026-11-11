// 日期 2026-11-11。真实 HTTP MCP、持久读取及浏览器面板；不替代原生交互证据。
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium} from '@playwright/test';
import {createServer,HttpError} from '../server/index.mjs';
import {prepareLightPlan} from '../server/light-import.mjs';

const output=path.resolve('test-results/manual-trial/F-EX01');await mkdir(output,{recursive:true});
const root=await mkdtemp(path.join(output,'http-'));
const sourceFile=path.resolve('../docs/03_轻量路线工作台/03_测试样例/01_模拟二十步骤与六分支工作树_测试文档_2026-11-10.md');
const text=await readFile(sourceFile,'utf8'),checks=[],transcript=[];
let server,browser,base,drop=false;
const context={sessionGroup:'F',threadId:'F-isolated-thread',hostId:'local',folderId:null,worktreeOrdinal:1,worktreePath:root,branch:'fixture',head:null,trust:'declared'};
async function check(name,fn){await fn();checks.push({name,result:'passed'});console.log('PASS '+name);}
async function open(){server=await createServer({dataDir:path.join(root,'data'),env:{},lightAccessEnabled:true,lightVerifyExecutionContext:()=>true,
 lightAuthorize:(p,...args)=>p==='fixture'||server.workbench.lightAccess.authorize(p,...args),
 authorize(req,url){if(url==='/api/light-mcp')return;if(req.headers.authorization!=='Bearer F-test-owner')throw new HttpError(403,'FORBIDDEN');},
 afterCommit(req){if(drop&&req.url==='/api/light-mcp'){drop=false;return 'drop';}}});await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;}
async function close(){if(server?.listening){server.closeAllConnections();await new Promise(r=>server.close(r));}}
try{
 await open();
 for(let i=1;i<=3;i++){
  const snapshot=prepareLightPlan({text,sourcePath:sourceFile,version:'F-fixture',projectKey:`F${i}/project`,planKey:`F${i}/plan`,name:`F持久项目${i}`,date:'2026-11-11',context});
  if(i===1){
   const template=snapshot.steps[0],route=snapshot.routes[0];
   function add(label,n,sourceStepKey=null){const key=`F1/route/${label}`,keys=[];for(let j=0;j<n;j++){const stepKey=`F1/${label}/${j}`;keys.push(stepKey);snapshot.steps.push({...structuredClone(template),key:stepKey,code:`${label}-${j+1}`,originalCode:`${label}-${j+1}`,title:`${label}持久长标题步骤${j+1}`,order:100+snapshot.steps.length,dependsOn:[],sourceLocator:'F隔离扩展场景',conditions:[]});}snapshot.routes.push({...structuredClone(route),key,label,stepKeys:keys,sourceStepKey,order:100+snapshot.routes.length});return keys[0];}
   add('长路线',30);let first;for(let j=0;j<8;j++){const k=add(`分支${j+1}`,1,template.key);if(!j)first=k;}add('深层',1,first);
  }
  snapshot.plans[0].stageKeys=snapshot.steps.filter(s=>s.parentKey===null).sort((a,b)=>a.order-b.order).map(s=>s.key);
  snapshot.plans[0].stageCount=snapshot.plans[0].stageKeys.length;
  await server.workbench.light.register('fixture',{eventId:`register-${i}`,expectedRevision:0,snapshot});
 }
 let snapshot=server.workbench.persistence.read('light').snapshot;
 const project=snapshot.projects[0],plan=snapshot.plans[0],step=snapshot.steps[0];
 const binding={key:'F1/binding',id:randomUUID(),projectKey:project.key,planKey:plan.key,stepKeys:[step.key],bindingRevision:1,state:'confirmed',context,confirmationRef:'isolated-trusted-fixture',revokedAt:null};
 const {trust,...source}=plan.source;
 const common=()=>({schemaVersion:'light-1.0',projectId:project.id,planId:plan.id,source,expectedRevision:server.workbench.light.read('fixture',project.id).projects[0].revision,eventId:randomUUID(),occurredAt:new Date().toISOString(),reason:'F隔离持久联验'});
 const grant=await(await fetch(base+'/api/light-access/grants',{method:'POST',headers:{Authorization:'Bearer F-test-owner','Content-Type':'application/json'},body:JSON.stringify({projectKeys:[project.key],threadId:context.threadId,hostId:'local',worktreeRoots:[root],acknowledged:true})})).json();
 await server.workbench.light.acceptBinding('fixture',{...common(),binding});
 async function call(name,args){const response=await fetch(base+'/api/light-mcp',{method:'POST',headers:{Authorization:`Bearer ${grant.token}`,'Content-Type':'application/json'},body:JSON.stringify({name,arguments:args})});const r=(await response.json()).structuredContent;transcript.push({name,args,result:r});return r;}
 const reservation=await call('workbench_reserve_execution',common());assert.equal(reservation.status,'accepted');
 const update={...common(),stepId:step.id,executionId:reservation.result.executionId,bindingId:binding.id,bindingRevision:1,targetStatus:'running',reason:'真实MCP更新到达F面板',evidence:[],checks:[],blocker:null,reopen:null,successorImpact:null};
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
 const ctx=await browser.newContext({viewport:{width:1280,height:800},extraHTTPHeaders:{Authorization:'Bearer F-test-owner'}});const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/?view=light-live');await page.locator('.lp-project').first().waitFor();
 await check('three persisted projects, six original routes, thirty stations and eight branches',async()=>{assert.equal(await page.locator('.lp-project').count(),3);assert.equal(await page.locator('.lp-demo').count(),0);assert.equal(await page.locator('.lp-branch').count(),3);await page.getByRole('button',{name:/另有 5 条分支/}).click();assert.equal(await page.locator('.lp-branch').count(),8);});
 await page.locator('.lp-station').first().click();await page.getByRole('button',{name:'查看完整详情'}).click();
 await check('verified original text and explicit missing thread-jump capability',async()=>{assert.ok((await page.locator('.lp-excerpt').innerText()).includes('日期'));await page.getByRole('button',{name:'打开关联会话'}).click();assert.ok((await page.locator('.lp-event').innerText()).includes('未绑定会话'));});
 await page.locator('.lp-project-scroll').first().evaluate(e=>{e.scrollLeft=450;});
 await check('MCP committed update, readback and UI agree while selection and position survive',async()=>{const r=await call('workbench_update_step_status',update);assert.equal(r.status,'accepted',JSON.stringify(r));await page.waitForFunction(()=>document.querySelector('.lp-event')?.textContent.includes('真实MCP更新到达F面板'));assert.ok((await page.locator('.lp-detail').innerText()).includes('执行中'));await page.getByRole('button',{name:'打开关联会话'}).click();assert.ok((await page.locator('.lp-association').innerText()).includes(context.threadId));assert.ok((await page.locator('.lp-project-scroll').first().evaluate(e=>e.scrollLeft))>=440);assert.equal(await page.locator('.lp-station[aria-pressed=true]').count(),1);const read=await call('workbench_get_project',{projectId:project.id});assert.equal(read.result.steps[0].status,'running');});
 await check('same event replay and stale conflicting write preserve committed state',async()=>{const replay=await call('workbench_update_step_status',update);assert.equal(replay.result.receipt.eventId,update.eventId);const stale=await call('workbench_update_step_status',{...update,eventId:randomUUID(),reason:'过期覆盖'});assert.equal(stale.error.code,'REVISION_CONFLICT');});
 await check('lost write response remains observable through original event query and committed UI',async()=>{drop=true;const unknown={...update,...common(),reason:'丢响应后按原事件查询'};await assert.rejects(call('workbench_update_step_status',unknown));const query=await call('workbench_query_event',{projectId:project.id,operation:'update',eventId:unknown.eventId});assert.equal(query.result.state,'committed');await page.waitForFunction(()=>document.querySelector('.lp-detail')?.textContent.includes('丢响应后按原事件查询'));});
 await check('read disconnect retains snapshot, recovery resumes without viewport jump',async()=>{await page.route('**/api/light-panel',r=>r.abort());await page.waitForFunction(()=>document.querySelector('.lp-sync')?.textContent.includes('连接中断'));assert.equal(await page.locator('.lp-project').count(),3);await page.unroute('**/api/light-panel');await page.getByRole('button',{name:'刷新',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.lp-sync')?.textContent.includes('已连接'));});
 await check('persisted reading preference survives page reload',async()=>{await page.waitForTimeout(700);await page.reload();await page.locator('.lp-project').first().waitFor();assert.equal(await page.locator('.lp-station[aria-pressed=true]').count(),1);assert.ok((await page.locator('.lp-project-scroll').first().evaluate(e=>e.scrollLeft))>=440);});
 await page.screenshot({path:path.join(output,'live-browser.png')});assert.deepEqual(errors,[]);
 await check('collapsed floating bar stays expanded after hover then click',async()=>{const floating=await ctx.newPage();await floating.goto(base+'/?view=light-live&floating=1');await floating.locator('.lp-compact').hover();await floating.locator('.lp-compact').click();await floating.waitForFunction(()=>document.querySelector('.lp-island')?.getAttribute('data-motion')==='expanded');assert.equal(await floating.locator('.lp-compact').getAttribute('aria-expanded'),'true');assert.equal(await floating.getByRole('button',{name:'已固定',exact:true}).getAttribute('aria-pressed'),'true');await floating.close();});
 await writeFile(path.join(output,'live-ui-result.json'),JSON.stringify({date:'2026-11-11',environment:'真实隔离HTTP MCP及持久快照、Edge浏览器；绑定使用可信测试适配器',checks,transcript},null,2));
}finally{await browser?.close();await close();assert.ok(root.startsWith(output+path.sep));await rm(root,{recursive:true,force:true});}
