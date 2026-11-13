// 日期：2026-11-13。真实领域状态验证连续调度、独立会话、暂停、恢复和失败门禁。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createPersistence} from './persistence.mjs';
import {createRequests} from './business-requests.mjs';
import {createLightAccess} from './light-access.mjs';
import {createLightService} from './light-service.mjs';
import {prepareLightPlan} from './light-import.mjs';
import {createContinuousRunner} from './light-continuous.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t,{hold=false,finish=true}={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'continuous-fixture-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const p=await createPersistence(path.join(root,'data')),access=createLightAccess(p),grant=await access.connect({appId:'codex',acknowledged:true});
 const service=createLightService(p,createRequests(p),{authorize:access.authorize,automaticBinding:access.automaticBinding,confirmBinding:access.verifyBinding,verifyExecutionContext:access.verifyExecutionContext});
 const file=path.join(root,'plan.md'),text='# 测试\n日期：2026-11-13\n## 实施路线与出口\n| 阶段 | 前置 | 范围 | 出口 |\n| A 第一步 | 无 | 空 | 成功 |\n| B 第二步 | A | 空 | 成功 |\n| C 第三步 | B | 空 | 成功 |\n';await writeFile(file,text);
 const context={sessionGroup:'A',threadId:null,hostId:null,folderId:null,worktreeOrdinal:1,worktreePath:root,branch:null,head:null,trust:'declared'};
 const candidate=prepareLightPlan({text,sourcePath:file,version:'1',projectKey:'test-project',planKey:'test-plan',name:'连续测试',date:'2026-11-13',context});
 const registered=await service.register(grant.principal,{eventId:'register',expectedRevision:0,snapshot:candidate});
 const created=[],requests=[];let release;
 async function complete(threadId){
  const s=service.read(grant.principal,registered.projectId),binding=s.bindings.find(b=>b.state==='confirmed'&&b.context.threadId===threadId),step=s.steps.find(x=>binding.stepKeys.includes(x.key)&&x.status==='running'),execution=s.executions.find(e=>e.key===step.executionKey);
  const {trust,...source}=s.plans[0].source;const proof={evidenceId:'proof-'+step.code,location:'fixture://'+step.code,method:'实际夹具返回成功',deliveryVersion:'1',result:'passed'};
  await service.update(grant.principal,{schemaVersion:'light-1.0',projectId:registered.projectId,planId:registered.planIds[0],expectedRevision:s.projects[0].revision,eventId:'complete-'+step.code,source,occurredAt:new Date().toISOString(),reason:'夹具验收通过',stepId:step.id,executionId:execution.id,bindingId:binding.id,bindingRevision:binding.bindingRevision,targetStatus:'completed',evidence:[proof],checks:step.conditions.map(c=>({...c,result:'passed',evidenceIds:[proof.evidenceId]})),blocker:null,reopen:null,successorImpact:null});
 }
 const factory=()=>({async create(cwd,title){const id='chat-'+(created.length+1);created.push({id,cwd,title});return{id,cwd};},async resume(){},async run(id,text,onStarted){requests.push({id,text});await onStarted?.('turn-'+requests.length);if(hold&&requests.length===1)await new Promise(r=>{release=r;});if(finish)await complete(id);return{status:'completed'};},close(){}});
 const runner=createContinuousRunner(p,service,{clientFactory:factory,principalProvider:()=>grant.principal});await runner.initialize();t.after(()=>runner.close());
 const change=action=>runner.change({planKey:'test-plan',action,expectedRevision:service.read(grant.principal,registered.projectId).projects[0].revision,acknowledged:true});
 async function until(status){for(let i=0;i<300;i++){if(runner.read()[0]?.status===status)return;await delay(10);}throw Error(JSON.stringify(runner.read()));}
 return{runner,created,requests,change,until,factory,release:()=>release?.(),snapshot:()=>service.read(grant.principal,registered.projectId),p,service,grant};
}
test('three declared stages create three separate sequential chats and only complete after actual service checks',async t=>{
 const f=await fixture(t);await f.change('start');await f.until('completed');assert.equal(f.created.length,3);assert.deepEqual(f.created.map(c=>c.title.split(' / ')[1][0]),['A','B','C']);assert.ok(f.snapshot().steps.every(s=>s.status==='completed'));assert.equal(f.runner.read()[0].completed,3);
 await f.change('start');await delay(20);assert.equal(f.created.length,3,'已完成方案不重复派发');
});
test('pause finishes current stage then stops dispatch; resume skips the completed stage',async t=>{
 const f=await fixture(t,{hold:true});await f.change('start');for(let i=0;i<100&&!f.requests.length;i++)await delay(10);await f.change('pause');f.release();await f.until('paused');assert.equal(f.created.length,1);assert.equal(f.snapshot().steps[0].status,'completed');await f.change('resume');await f.until('completed');assert.equal(f.created.length,3);
});
test('a completed chat without passed acceptance blocks rather than launching its successor',async t=>{
 const f=await fixture(t,{finish:false});await f.change('start');await f.until('blocked');assert.equal(f.created.length,1);assert.equal(f.snapshot().steps[1].status,'pending');assert.match(f.runner.read()[0].reason,/验收未通过/);
});
test('unknown thread creation remains a review checkpoint instead of being blindly recreated',async t=>{
 const f=await fixture(t);await f.p.run(()=>f.p.write('lightContinuous',{version:1,runs:[{id:'unknown',planKey:'test-plan',status:'running',sourceHash:f.snapshot().plans[0].source.sha256,current:{creationAttempted:true,threadId:null},history:[]}]}));
 await f.runner.initialize();assert.equal(f.runner.read()[0].status,'paused');await f.change('resume');await f.until('blocked');assert.equal(f.created.length,0);assert.match(f.runner.read()[0].reason,/THREAD_CREATION_RESULT_UNKNOWN/);
});
test('source changes and missing acknowledgment cannot create chats',async t=>{
 const f=await fixture(t);await assert.rejects(f.runner.change({planKey:'test-plan',action:'start',expectedRevision:f.snapshot().projects[0].revision}),/连续执行请求无效/);
 await writeFile(f.snapshot().plans[0].source.path,'changed');await assert.rejects(f.change('start'),/SOURCE_CHANGED/);assert.equal(f.created.length,0);
});
test('stale owner requests cannot silently start a newer plan revision',async t=>{
 const f=await fixture(t);await assert.rejects(f.runner.change({planKey:'test-plan',action:'start',expectedRevision:0,acknowledged:true}),/任务已更新/);assert.equal(f.created.length,0);
});
test('enabling continuous execution during an existing stage follows its chat without duplicate execution',async t=>{
 const f=await fixture(t,{hold:true});await f.change('start');for(let i=0;i<100&&!f.requests.length;i++)await delay(10);
 f.runner.close();await f.p.run(()=>f.p.write('lightContinuous',{version:1,runs:[]}));
 const runner=createContinuousRunner(f.p,f.service,{clientFactory:f.factory,principalProvider:()=>f.grant.principal});await runner.initialize();t.after(()=>runner.close());
 await runner.change({planKey:'test-plan',action:'start',expectedRevision:f.snapshot().projects[0].revision,acknowledged:true});
 await delay(100);assert.equal(f.created.length,1);assert.equal(runner.read()[0].threadId,'chat-1');f.release();
 for(let i=0;i<400&&runner.read()[0].status==='running';i++)await delay(10);
 assert.equal(runner.read()[0].status,'completed');assert.equal(f.created.length,3);
});
test('all stages passing cannot silently sign off pending final plan conditions',async t=>{
 const f=await fixture(t);await f.p.run(()=>{const light=f.p.read('light');light.snapshot.plans[0].endConditions=[{conditionId:'final',text:'独立最终验收',required:true,result:'pending',evidenceIds:[]}];f.p.write('light',light);});
 f.runner.close();const runner=createContinuousRunner(f.p,f.service,{principalProvider:()=>f.grant.principal,clientFactory:()=>{const c=f.factory(),run=c.run;c.run=(id,text,onStarted)=>text.includes('所有阶段已通过')?Promise.resolve({status:'completed'}):run(id,text,onStarted);return c;}});await runner.initialize();t.after(()=>runner.close());
 await runner.change({planKey:'test-plan',action:'start',expectedRevision:f.snapshot().projects[0].revision,acknowledged:true});for(let i=0;i<400&&runner.read()[0].status==='running';i++)await delay(10);
 assert.equal(runner.read()[0].status,'blocked');assert.equal(runner.read()[0].completed,3);assert.equal(f.snapshot().plans[0].endConditions[0].result,'pending');assert.match(runner.read()[0].reason,/结束条件尚未通过/);
});
test('restart after final commit queries its original event without repeating the final write',async t=>{
 const f=await fixture(t);await f.change('start');await f.until('completed');const revision=f.snapshot().projects[0].revision;
 await f.p.run(()=>{const state=f.p.read('lightContinuous');state.runs[0].status='paused';f.p.write('lightContinuous',state);});
 await f.change('resume');await f.until('completed');assert.equal(f.snapshot().projects[0].revision,revision);assert.equal(f.created.length,3);
});
