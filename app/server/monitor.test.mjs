import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {applyReceiptCommand} from './receipts.mjs';
import {inspectMonitor,reconcileLifecycle,applyStart} from './monitor.mjs';
import {createModelStore} from './model-store.mjs';

const model=()=>({folders:[{id:'F'}],tasks:[{id:'T',name:'开发线',folderId:'F',goal:'原定任务',initialGoal:'原定任务',acceptance:['任务验收'],handoff:'无'}],chats:[{id:'C',taskId:'T',folderId:'F'}],plans:[{id:'V',version:'1',source:'原文',goal:'原定项目',acceptance:['项目验收'],previousId:null}],initialPlanId:'V',currentPlanId:'V',acceptance:['项目验收'],stations:[{id:'A',taskId:'T',code:'A',title:'实现',scope:'既定范围',planId:'V',acceptance:['本站验收'],dependsOn:[],successors:[]}]});
const receipt=(m,id)=>{const s=m.stations.find(s=>s.id===id);return {projectId:'P',folderId:'F',taskId:s.taskId,stationId:id,planId:'V',sourceId:m.chats.find(c=>c.taskId===s.taskId).id,deliveryVersion:'sha1',raw:'日期：2026-11-08\n完成回执',actual:`${id} 实际交付`,blockers:[],checks:[],next:s.successors.map(stationId=>({stationId,goal:'后继目标',scope:'既定范围',delivery:'后继验收'}))};};
const review=(m,id,project=true)=>{const s=m.stations.find(s=>s.id===id),t=m.tasks.find(t=>t.id===s.taskId),check=criterion=>({criterion,result:'passed',reason:'核对原定目标与实际交付一致',evidenceIds:['e']});return {reviewer:'验收人',method:'检查原文与测试报告',checks:s.acceptance.map(check),taskChecks:[...t.acceptance,`原始任务目标：${t.initialGoal}`].map(check),projectChecks:project?['项目验收','原始目标：原定项目'].map(check):[],evidence:[{id:'e',location:'结果.json',deliveryVersion:'sha1',method:'读取实际报告',reason:'对应交付版本且通过',result:'valid'}],handoffs:s.successors.map(stationId=>({stationId,result:'matched',reason:'原定目标、范围和交付一致'}))};};
function command(m,body){return reconcileLifecycle('P',applyReceiptCommand('P',m,body)??m);}
function imported(m,id){return command(m,{action:'import',receipt:receipt(m,id)});}
function verified(m,id,project=true,overrides={}){const e=m.receiptLog.receipts.filter(e=>e.receipt.stationId===id).at(-1);return command(m,{action:'review',receiptId:e.id,review:{...review(m,id,project),...overrides}});}
const view=m=>inspectMonitor('P',m);
function fork(){const m=model();m.stations[0].successors=['B'];m.stations.push({...m.stations[0],id:'B',code:'B',title:'验收',dependsOn:['A'],successors:[]});return m;}

test('暗色可开始与实际绿色开始分开，旧手动状态不冒充新状态',()=>{
 let m=fork();assert.equal(view(m).stations[0].color,'dark');assert.equal(view(m).stations[0].label,'可开始');assert.deepEqual(view(m).stations[1].waiting,['A']);
 m.stations[0].report={status:'done'};assert.equal(view(m).stations[0].label,'待核验');assert.equal(view(m).stations[0].color,'dark');
 assert.throws(()=>applyStart('P',m,{stationId:'A',sourceId:'wrong',executionId:'x',evidence:'开始消息'}),/来源/);
 m=applyStart('P',m,{stationId:'A',sourceId:'C',executionId:'x',evidence:'开始消息'});assert.equal(view(m).stations[0].color,'green');
 assert.equal(applyStart('P',m,{stationId:'A',sourceId:'C',executionId:'x',evidence:'开始消息'}),null);
});
test('报告完成后缺证据转暗色；本站通过红色，后继可开始仍暗色',()=>{
 let m=applyStart('P',fork(),{stationId:'A',sourceId:'C',executionId:'x',evidence:'真实开始消息'});
 m=imported(m,'A');assert.equal(view(m).stations[0].color,'dark');assert.equal(view(m).stations[0].label,'待核验');
 m=verified(m,'A');assert.equal(view(m).stations[0].color,'red');assert.equal(view(m).stations[1].color,'dark');assert.equal(view(m).stations[1].label,'可开始');
 m=applyStart('P',m,{stationId:'B',sourceId:'C',executionId:'y',evidence:'后继实际开始消息'});assert.equal(view(m).stations[1].color,'green');
});
test('本站完成而范围不符，保持红色并明确偏离，不解锁后继',()=>{
 let m=verified(imported(fork(),'A'),'A',true,{handoffs:[{stationId:'B',result:'mismatch',reason:'范围偏离'}]});assert.equal(view(m).stations[0].color,'red');assert.match(view(m).stations[0].label,/偏离/);assert.equal(view(m).stations[1].ready,false);
 assert.throws(()=>applyStart('P',m,{stationId:'B',sourceId:'C',executionId:'x',evidence:'开始'}),/前置/);
});
test('任务与项目自动分别关闭，保存原目标及证据，重复读取不重复关闭',()=>{
 const m=verified(imported(model(),'A'),'A');const result=view(m);
 assert.equal(result.tasks[0].status,'closed');assert.equal(result.project.status,'closed');assert.equal(m.lifecycle.closures.length,2);
 assert.equal(result.project.closure.originalGoal,'原定项目');assert.equal(result.tasks[0].closure.originalGoal,'原定任务');assert.deepEqual(result.tasks[0].closure.actual,['A 实际交付']);assert.equal(result.project.closure.originalExpectation,'满足');
 assert.deepEqual(reconcileLifecycle('P',m),m);
});
test('证据失效不删除关闭历史，追加待复核且不重复；复验可重闭',()=>{
 let m=verified(imported(model(),'A'),'A');const first=m.lifecycle.closures[0];
 m=command(m,{action:'invalidate',reviewId:m.receiptLog.reviews[0].id,reason:'证据撤回'});assert.equal(view(m).tasks[0].status,'recheck');assert.equal(view(m).project.status,'recheck');assert.equal(view(m).stations[0].color,'dark');assert.deepEqual(m.lifecycle.closures[0],first);
 assert.equal(m.lifecycle.events.filter(e=>e.type==='recheck').length,2);assert.deepEqual(reconcileLifecycle('P',m),m);
 m=verified(m,'A');assert.equal(view(m).project.status,'closed');assert.equal(m.lifecycle.closures.length,4);
 assert.equal(new Set(m.lifecycle.closures.map(c=>c.id)).size,4);
});
test('原始目标缺失不猜测，任务完成不等于项目完成',()=>{
 let m=verified(imported(model(),'A'),'A',false);assert.equal(view(m).tasks[0].status,'closed');assert.equal(view(m).project.status,'open');
 m=model();delete m.tasks[0].initialGoal;m=verified(imported(m,'A'),'A');assert.equal(view(m).tasks[0].status,'open');assert.match(view(m).tasks[0].reason,/原始任务目标/);
});
test('四线交付而集成未完成，四任务可关闭，集成与项目保持开放',()=>{
 let m=model();m.tasks=[];m.chats=[];m.stations=[];
 for(const id of ['S','H','C','U','I']){m.tasks.push({id,name:id,folderId:'F',goal:'交付',initialGoal:'交付',acceptance:['任务验收'],handoff:id==='I'?'无':'集成任务 I'});m.chats.push({id:`chat-${id}`,taskId:id,folderId:'F'});m.stations.push({id,code:id,title:id,scope:'既定范围',taskId:id,planId:'V',acceptance:['本站验收'],dependsOn:id==='I'?['S','H','C','U']:[],successors:id==='I'?[]:['I']});}
 for(const id of ['S','H','C','U'])m=verified(imported(m,id),id,false);
 assert.equal(view(m).tasks.filter(t=>t.status==='closed').length,4);assert.equal(view(m).tasks.find(t=>t.id==='I').status,'open');assert.equal(view(m).project.status,'open');assert.equal(view(m).stations.find(s=>s.id==='I').label,'可开始');
});
test('自动收敛与实际开始持久化、重开一致，普通模型更新不能篡改关闭历史',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'m04-store-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const project={id:'P',name:'项目',goal:'原定项目',source:'原文',steps:[]},projects={get:()=>structuredClone(project)},store=await createModelStore(dir,projects);
 assert.equal((await store.monitor('P')).revision,0);assert.equal((await store.get('P')).revision,0); // reading an unsaved legacy model must not freeze later imports
 await store.update('P',{revision:0,model:model()});let saved=await store.get('P');await store.start('P',{revision:saved.revision,stationId:'A',sourceId:'C',executionId:'x',evidence:'实际开始消息'});
 const active=await store.monitor('P');assert.equal(active.stations[0].color,'green');const reopened=await createModelStore(dir,projects);assert.deepEqual(await reopened.monitor('P'),active);
 saved=await store.get('P');await store.command('P',{revision:saved.revision,action:'import',receipt:receipt(saved.model,'A')});saved=await store.get('P');await store.command('P',{revision:saved.revision,action:'review',receiptId:saved.model.receiptLog.receipts[0].id,review:review(saved.model,'A')});
 const closed=await store.monitor('P');assert.equal(closed.project.status,'closed');assert.deepEqual(await reopened.monitor('P'),closed);
 saved=await store.get('P');saved.model.lifecycle={starts:[],closures:[],events:[]};await store.update('P',saved);assert.equal((await store.monitor('P')).lifecycle.closures.length,2);
});
