import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {createServer} from '../server/index.mjs';
const dataDir=await mkdtemp(path.join(tmpdir(),'m04-ui-'));let server,browser;
async function start(){server=await createServer({dataDir,env:{}});await new Promise(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${server.address().port}`;}
async function stop(){if(server){server.closeAllConnections();await new Promise(r=>server.close(r));server=null;}}
try{
 let base=await start();
 async function request(url,method='GET',body){const res=await fetch(base+url,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});assert.equal(res.ok,true,await res.clone().text());return res.json();}
 const {project:p}=await request('/api/projects','POST',{name:'M04隔离验收',goal:'原定项目',steps:[]});const root=`/api/projects/${p.id}`;
 const saved=await request(root+'/model'),m=saved.model;
 m.tasks=[{id:'T',name:'开发任务',folderId:'F',goal:'原定任务',initialGoal:'原定任务',acceptance:['任务验收'],handoff:'无'}];m.folders=[{id:'F'}];m.chats=[{id:'C',taskId:'T',folderId:'F',externalId:'执行聊天'}];m.plans=[{id:'V',version:'1',source:'基线',goal:'原定项目',acceptance:['项目验收'],previousId:null}];m.initialPlanId='V';m.currentPlanId='V';m.acceptance=['项目验收'];
 m.stations=['A','B'].map(id=>({id,taskId:'T',code:id,title:id==='A'?'实现':'验收',scope:'既定范围',planId:'V',acceptance:['本站验收'],dependsOn:id==='B'?['A']:[],successors:id==='A'?['B']:[]}));
 await request(root+'/model','PUT',saved);
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(base);
 const a=page.getByTestId('monitor-A'),b=page.getByTestId('monitor-B');await a.waitFor();assert.equal(await a.getAttribute('data-color'),'dark');assert.match(await a.textContent(),/可开始/);assert.match(await b.textContent(),/等待依赖/);
 await a.click();await page.getByLabel('实际执行聊天',{exact:true}).selectOption('C');await page.getByLabel('实际开始证据',{exact:true}).fill('开始消息#1');await page.getByRole('button',{name:'登记实际开始',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-testid="monitor-A"]')?.getAttribute('data-color')==='green');
 const check=criterion=>({criterion,result:'passed',reason:'按原定条件验收通过',evidenceIds:['e']});
 async function complete(id,project){
  let v=await request(root+'/receipts');const receipt={projectId:p.id,folderId:'F',taskId:'T',stationId:id,planId:'V',sourceId:'C',deliveryVersion:'sha',raw:'日期：2026-11-08\n完成',actual:`${id}交付`,checks:[],blockers:[],next:id==='A'?[{stationId:'B',goal:'验收',scope:'既定范围',delivery:'结果报告'}]:[]};
  v=await request(root+'/receipts','POST',{revision:v.revision,action:'import',receipt});
  const review={reviewer:'核验人',method:'检查原文和版本结果',checks:['本站验收'].map(check),taskChecks:['任务验收','原始任务目标：原定任务'].map(check),projectChecks:project?['项目验收','原始目标：原定项目'].map(check):[],handoffs:id==='A'?[{stationId:'B',result:'matched',reason:'头尾目标、范围、交付一致'}]:[],evidence:[{id:'e',location:'隔离结果',deliveryVersion:'sha',result:'valid',method:'读取实际结果',reason:'对应版本与验收项'}]};
  await request(root+'/receipts','POST',{revision:v.revision,action:'review',receiptId:v.log.receipts.at(-1).id,review});
 }
 await complete('A',false);await page.getByRole('button',{name:'刷新监测',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-testid="monitor-A"]')?.getAttribute('data-color')==='red');assert.equal(await b.getAttribute('data-color'),'dark');assert.match(await b.textContent(),/可开始/);
 await b.click();await page.getByLabel('实际执行聊天',{exact:true}).selectOption('C');await page.getByLabel('实际开始证据',{exact:true}).fill('开始消息#2');await page.getByRole('button',{name:'登记实际开始',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-testid="monitor-B"]')?.getAttribute('data-color')==='green');
 await complete('B',false);await page.getByRole('button',{name:'刷新监测',exact:true}).click();await page.getByRole('heading',{name:'任务 开发任务：已结束',exact:true}).waitFor();await page.getByRole('heading',{name:'项目：未结束',exact:true}).waitFor();
 let v=await request(root+'/receipts'),entry=v.log.receipts.at(-1),prior=v.log.reviews.at(-1).review;
 await request(root+'/receipts','POST',{revision:v.revision,action:'review',receiptId:entry.id,review:{...prior,projectChecks:['项目验收','原始目标：原定项目'].map(check)}});
 await page.getByRole('button',{name:'刷新监测',exact:true}).click();await page.getByRole('heading',{name:'项目：已结束',exact:true}).waitFor();const closed=await request(root+'/monitor');assert.equal(closed.project.originalExpectation,'满足');
 const output=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../test-results');await mkdir(output,{recursive:true});await page.locator('.monitor').screenshot({path:path.join(output,'m04-monitor.png')});
 await stop();base=await start();await page.goto(base);await page.getByRole('heading',{name:'项目：已结束',exact:true}).waitFor();assert.deepEqual(await request(root+'/monitor'),closed);
 v=await request(root+'/receipts');await request(root+'/receipts','POST',{revision:v.revision,action:'invalidate',reviewId:v.log.reviews.at(-1).id,reason:'证据失效'});await page.getByRole('button',{name:'刷新监测',exact:true}).click();await page.getByRole('heading',{name:'项目：历史已关闭，当前待复核',exact:true}).waitFor();assert.equal((await request(root+'/monitor')).lifecycle.closures.length,closed.lifecycle.closures.length);assert.deepEqual(errors,[]);
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'收起 AI 助手',exact:true}).click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
 console.log('PASS M04 浏览器暗→绿→红、后继可开始不亮绿、任务/项目分别自动关闭、原目标对照、冷重开、失效历史及手机布局');
}finally{await browser?.close();await stop();await rm(dataDir,{recursive:true,force:true});}
