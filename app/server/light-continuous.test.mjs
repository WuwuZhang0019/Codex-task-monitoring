// 日期：2026-11-13。真实领域状态验证连续调度、独立会话、暂停、恢复和失败门禁。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import http from 'node:http';
import {createServer,HttpError} from './index.mjs';
import os from 'node:os';
import path from 'node:path';
import {createPersistence} from './persistence.mjs';
import {createRequests} from './business-requests.mjs';
import {createLightAccess} from './light-access.mjs';
import {createLightService} from './light-service.mjs';
import {prepareLightPlan} from './light-import.mjs';
import {createContinuousRunner} from './light-continuous.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t,{hold=false,finish=true,decorateClient=client=>client}={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'continuous-fixture-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const p=await createPersistence(path.join(root,'data')),access=createLightAccess(p),grant=await access.connect({appId:'codex',acknowledged:true});
 const service=createLightService(p,createRequests(p),{authorize:access.authorize,automaticBinding:access.automaticBinding,confirmBinding:access.verifyBinding,verifyExecutionContext:access.verifyExecutionContext});
 const file=path.join(root,'plan.md'),text='# 测试\n日期：2026-11-13\n## 实施路线与出口\n| 阶段 | 前置 | 范围 | 出口 |\n| A 第一步 | 无 | 空 | 成功 |\n| B 第二步 | A | 空 | 成功 |\n| C 第三步 | B | 空 | 成功 |\n';await writeFile(file,text);
 const context={sessionGroup:'A',threadId:null,hostId:null,folderId:null,worktreeOrdinal:1,worktreePath:root,branch:null,head:null,trust:'declared'};
 const candidate=prepareLightPlan({text,sourcePath:file,version:'1',projectKey:'test-project',planKey:'test-plan',name:'连续测试',date:'2026-11-13',context});
 const registered=await service.register(grant.principal,{eventId:'register',expectedRevision:0,snapshot:candidate});
 const created=[],requests=[],notifications=[],transports=[],turns=new Map(),held=new Set();let release;
 async function complete(threadId){
  const s=service.read(grant.principal,registered.projectId),step=s.steps.find(x=>x.status==='running'&&s.bindings.some(b=>b.key===x.bindingKey&&b.state==='confirmed'&&b.context.threadId===threadId)),binding=s.bindings.find(b=>b.key===step?.bindingKey),execution=s.executions.find(e=>e.key===step?.executionKey);
  assert.ok(step&&binding&&execution,'夹具必须完成该会话当前真正执行的阶段');
  const {trust,...source}=s.plans[0].source;const proof={evidenceId:'proof-'+step.code,location:'fixture://'+step.code,method:'实际夹具返回成功',deliveryVersion:'1',result:'passed'};
  await service.update(grant.principal,{schemaVersion:'light-1.0',projectId:registered.projectId,planId:registered.planIds[0],expectedRevision:s.projects[0].revision,eventId:'complete-'+step.code,source,occurredAt:new Date().toISOString(),reason:'夹具验收通过',stepId:step.id,executionId:execution.id,bindingId:binding.id,bindingRevision:binding.bindingRevision,targetStatus:'completed',evidence:[proof],checks:step.conditions.map(c=>({...c,result:'passed',evidenceIds:[proof.evidenceId]})),blocker:null,reopen:null,successorImpact:null});
 }
 const factory=(options={})=>{transports.push(options.transport??'owned');return decorateClient({
  async create(cwd,title){const id='chat-'+(created.length+1);created.push({id,cwd,title});return{id,cwd};},
  async connect(){},async attach(id){return this.readThread(id);},async resume(id){return {thread:{id,cwd:root}};},
  async readThread(id){return {id,cwd:root,status:{type:turns.get(id)?.status==='inProgress'?'active':'idle'},turns:turns.has(id)?[turns.get(id)]:[]};},
  async notify(id,text){const turn=turns.get(id),delivery=options.transport==='shared'?'sent':turn?.status==='inProgress'?'steered':'started';notifications.push({id,text,turnId:turn?.id,delivery,active:turn?.status==='inProgress'});return {turnId:turn?.id??'notify-'+notifications.length,delivery};},
  async run(id,text,onStarted){requests.push({id,text});const turn={id:'turn-'+requests.length,status:'inProgress'};turns.set(id,turn);await onStarted?.(turn.id);if(hold===true&&requests.length===1||Array.isArray(hold)&&hold.includes(requests.length))await new Promise(r=>{held.add(requests.length);release=r;});if(finish)await complete(id);turn.status='completed';return{...turn};},close(){}
 },options);};
 const runner=createContinuousRunner(p,service,{clientFactory:factory,principalProvider:()=>grant.principal});await runner.initialize();t.after(()=>runner.close());
 const change=(action,mode)=>runner.change({planKey:'test-plan',action,expectedRevision:service.read(grant.principal,registered.projectId).projects[0].revision,acknowledged:true,...(mode?{mode}:{})});
 async function until(status){for(let i=0;i<700;i++){if(runner.read()[0]?.status===status)return;await delay(10);}throw Error(JSON.stringify(runner.read()));}
 return{root,runner,created,requests,notifications,transports,turns,held,change,until,factory,complete,release:()=>release?.(),snapshot:()=>service.read(grant.principal,registered.projectId),p,service,grant};
}
test('three declared stages create three separate sequential chats and only complete after actual service checks',async t=>{
 const f=await fixture(t);await f.change('start');await f.until('completed');assert.equal(f.created.length,3);assert.deepEqual(f.created.map(c=>c.title.split(' / ')[1][0]),['A','B','C']);assert.ok(f.snapshot().steps.every(s=>s.status==='completed'));assert.equal(f.runner.read()[0].completed,3);
 await f.change('start');await delay(20);assert.equal(f.created.length,3,'已完成方案不重复派发');
});
test('pause finishes current stage then stops dispatch; resume skips the completed stage',async t=>{
 const f=await fixture(t,{hold:true});await f.change('start');for(let i=0;i<100&&!f.requests.length;i++)await delay(10);await f.change('pause');f.release();await f.until('paused');assert.equal(f.created.length,1);assert.equal(f.snapshot().steps[0].status,'completed');await f.change('resume');await f.until('completed');assert.equal(f.created.length,3);
});
test('pause accepts a stale business revision but still requires a nonnegative safe integer',async t=>{
 const f=await fixture(t,{hold:true});await f.change('start');for(let i=0;i<100&&!f.requests.length;i++)await delay(10);await delay(20);t.after(()=>f.release());
 for(const revision of [undefined,-1,0.5,'0',Number.MAX_SAFE_INTEGER+1])await assert.rejects(f.runner.change({planKey:'test-plan',action:'pause',expectedRevision:revision,acknowledged:true}),/连续执行请求无效/);
 const revision=f.snapshot().projects[0].revision;assert.ok(revision>0);await f.runner.change({planKey:'test-plan',action:'pause',expectedRevision:0,acknowledged:true});assert.equal(f.runner.read()[0].status,'pausing');
 await assert.rejects(f.runner.change({planKey:'test-plan',action:'resume',expectedRevision:0,acknowledged:true}),/任务已更新/);assert.equal(f.runner.read()[0].status,'pausing');
 f.release();await f.until('paused');assert.equal(f.created.length,1);assert.equal(f.snapshot().steps[1].status,'pending');
});
test('a draining stage can be re-enabled then disabled again without creating another chat',async t=>{
 const f=await fixture(t,{hold:true});await f.change('start');for(let i=0;i<100&&!f.requests.length;i++)await delay(10);await delay(20);t.after(()=>f.release());
 await f.change('pause');assert.equal(f.runner.read()[0].status,'pausing');await f.change('resume');await delay(30);assert.equal(f.runner.read()[0].status,'running');assert.equal(f.created.length,1);assert.equal(f.requests.length,1);
 await f.change('pause');f.release();await f.until('paused');assert.equal(f.created.length,1);assert.equal(f.snapshot().steps[0].status,'completed');assert.equal(f.snapshot().steps[1].status,'pending');
 await f.change('resume');await f.until('completed');assert.equal(f.created.length,3);assert.equal(f.requests.length,3);
});
test('resume accepted while the old pump exits is dispatched after that pump releases its slot',async t=>{
 const f=await fixture(t,{hold:true});await f.change('start');for(let i=0;i<100&&!f.requests.length;i++)await delay(10);await delay(20);t.after(()=>f.release());await f.change('pause');
 const run=f.p.run.bind(f.p);let releaseExit,pausedCommit;let intercept=true;
 const paused=new Promise(resolve=>{pausedCommit=resolve;});const exitGate=new Promise(resolve=>{releaseExit=resolve;});t.after(()=>releaseExit());
 f.p.run=async callback=>{const before=f.runner.read()[0]?.status;const result=await run(callback);if(intercept&&before==='pausing'&&f.runner.read()[0]?.status==='paused'){intercept=false;pausedCommit();await exitGate;}return result;};
 f.release();await paused;await f.change('resume');await delay(30);assert.equal(f.runner.read()[0].status,'running');assert.equal(f.created.length,1,'旧泵仍持有时不重复启动');releaseExit();await f.until('completed');assert.equal(f.created.length,3);assert.equal(f.requests.length,3);
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

// 日期：2026-11-13。覆盖用户录像中的启动失败、受阻反馈与两种执行方式。
test('missing registered workspaces are rejected before enabling or creating a chat',async t=>{
 const f=await fixture(t);
 await f.p.run(()=>{const light=f.p.read('light');for(const route of light.snapshot.routes)route.context.worktreePath=path.join(f.root,'missing-workspace');f.p.write('light',light);});
 await assert.rejects(f.change('start'),error=>error.status>=400&&error.status<500&&/目录|WORKSPACE|不存在/.test(error.message));
 assert.equal(f.created.length,0);assert.equal(f.runner.read().length,0,'预检失败不能短暂创建开启状态');
});

test('changed sources report a recoverable client error before enabling',async t=>{
 const f=await fixture(t);await writeFile(f.snapshot().plans[0].source.path,'changed');
 await assert.rejects(f.change('start'),error=>error.status>=400&&error.status<500&&/SOURCE_CHANGED/.test(error.message));
 assert.equal(f.created.length,0);assert.equal(f.runner.read().length,0);
});

test('blocked runs keep the enabled intention and can be explicitly turned off without retrying',async t=>{
 const f=await fixture(t,{finish:false});await f.change('start');await f.until('blocked');
 const blocked=f.runner.read()[0];assert.equal(blocked.enabled,true);assert.equal(blocked.mode,'stages');assert.match(blocked.reason,/验收未通过/);
 await f.change('pause');assert.equal(f.runner.read()[0].enabled,false);assert.equal(f.runner.read()[0].status,'paused');
 await delay(30);assert.equal(f.requests.length,1);assert.equal(f.created.length,1);
});

test('completed plans without continuous history stay visibly completed even when the old source changed',async t=>{
 const f=await fixture(t);await f.change('start');await f.until('completed');
 await f.p.run(()=>f.p.write('lightContinuous',{version:1,runs:[]}));
 await writeFile(f.snapshot().plans[0].source.path,'later documentation edits');
 const displayed=f.runner.read()[0];assert.equal(displayed.status,'completed');assert.equal(displayed.enabled,false);assert.equal(displayed.completed,3);
 const result=await f.change('start');assert.equal(result.run.status,'completed');assert.equal(f.created.length,3);assert.equal(f.requests.length,3);
});

test('restart migrates a legacy enabled run to an explicit disabled pause',async t=>{
 const f=await fixture(t);
 await f.p.run(()=>f.p.write('lightContinuous',{version:1,runs:[{id:'legacy',planKey:'test-plan',status:'running',sourceHash:f.snapshot().plans[0].source.sha256,current:null,history:[]}]}));
 await f.runner.initialize();const run=f.runner.read()[0];
 assert.equal(run.status,'paused');assert.equal(run.enabled,false);assert.equal(run.mode,'stages');assert.equal(f.created.length,0);
});

test('unknown execution modes cannot enable a run',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.change('start','everything'),/连续执行请求无效|INVALID_INPUT/);
 assert.equal(f.created.length,0);assert.equal(f.runner.read().length,0);
});

test('current-thread mode keeps all accepted stages in one chat',async t=>{
 const f=await fixture(t);await f.change('start','current_thread');await f.until('completed');
 assert.equal(f.created.length,1);assert.equal(f.requests.length,3);assert.equal(new Set(f.requests.map(item=>item.id)).size,1);
 assert.equal(f.runner.read()[0].mode,'current_thread');assert.equal(f.runner.read()[0].enabled,false);assert.ok(f.snapshot().steps.every(step=>step.status==='completed'));
});

test('current-thread mode immediately notifies an existing active stage once and reuses its chat',async t=>{
 const f=await fixture(t,{hold:true});await f.change('start');for(let i=0;i<100&&!f.requests.length;i++)await delay(10);t.after(()=>f.release());
 f.runner.close();await f.p.run(()=>f.p.write('lightContinuous',{version:1,runs:[]}));
 const runner=createContinuousRunner(f.p,f.service,{clientFactory:f.factory,principalProvider:()=>f.grant.principal});await runner.initialize();t.after(()=>runner.close());
 const change=()=>runner.change({planKey:'test-plan',action:'start',mode:'current_thread',expectedRevision:f.snapshot().projects[0].revision,acknowledged:true});
 await change();for(let i=0;i<150&&!f.notifications.length;i++)await delay(10);
 assert.equal(f.notifications.length,1);assert.equal(f.notifications[0].id,'chat-1');assert.equal(f.notifications[0].delivery,'sent');assert.equal(f.notifications[0].active,true);assert.equal(f.requests.length,1,'通知不能把当前阶段再执行一遍');
 await change();await delay(30);assert.equal(f.notifications.length,1,'重复开启不能重复投递指令');assert.ok(f.transports.includes('shared'),'原会话通过正确宿主连接');
 f.release();for(let i=0;i<700&&runner.read()[0].status==='running';i++)await delay(10);
 assert.equal(runner.read()[0].status,'completed');assert.equal(f.created.length,1);assert.equal(new Set(f.requests.map(item=>item.id)).size,1);
});

test('current-thread mode refuses incompatible workspaces before dispatch',async t=>{
 const f=await fixture(t),other=path.join(f.root,'other-workspace');await mkdir(other);
 await f.p.run(()=>{const light=f.p.read('light'),route=light.snapshot.routes[0],second=light.snapshot.steps.find(step=>step.code==='B');route.stepKeys=route.stepKeys.filter(key=>key!==second.key);light.snapshot.routes.push({...structuredClone(route),id:'other-route-id',key:'other-route',order:route.order+1,stepKeys:[second.key],context:{...route.context,worktreePath:other}});f.p.write('light',light);});
 await assert.rejects(f.change('start','current_thread'),error=>error.status>=400&&error.status<500&&/工作树|目录|WORKSPACE/.test(error.message));
 assert.equal(f.created.length,0);assert.equal(f.notifications.length,0);
});

test('same-thread completion still cannot bypass missing stage acceptance',async t=>{
 const f=await fixture(t,{finish:false});await f.change('start','current_thread');await f.until('blocked');
 assert.equal(f.created.length,1);assert.equal(f.requests.length,1);assert.equal(f.snapshot().steps.find(step=>step.code==='B').status,'pending');assert.equal(f.runner.read()[0].enabled,true);
});


test('pausing current-thread execution drains only its current stage and resumes the same chat',async t=>{
 const f=await fixture(t,{hold:true});await f.change('start','current_thread');for(let i=0;i<100&&!f.requests.length;i++)await delay(10);t.after(()=>f.release());
 await f.change('pause');assert.equal(f.runner.read()[0].enabled,false);f.release();await f.until('paused');
 assert.equal(f.requests.length,1);assert.equal(f.snapshot().steps.find(step=>step.code==='B').status,'pending');
 await f.change('resume','current_thread');await f.until('completed');assert.equal(f.created.length,1);assert.equal(new Set(f.requests.map(item=>item.id)).size,1);
});

test('switching from staged execution while its current stage drains notifies and then reuses that chat',async t=>{
 const f=await fixture(t,{hold:true});await f.change('start','stages');for(let i=0;i<100&&!f.requests.length;i++)await delay(10);t.after(()=>f.release());
 await f.change('pause');await f.change('resume','current_thread');for(let i=0;i<100&&!f.notifications.length;i++)await delay(10);
 assert.equal(f.notifications.length,1);assert.equal(f.notifications[0].id,'chat-1');assert.equal(f.requests.length,1);
 f.release();await f.until('completed');assert.equal(f.created.length,1);assert.equal(f.runner.read()[0].mode,'current_thread');
});


async function reviseSource(f){
 const before=f.snapshot(),plan=before.plans[0],text=await readFile(plan.source.path,'utf8')+'\n修订说明：2026-11-13，仅更新说明，阶段范围与验收条件保持不变。\n';
 await writeFile(plan.source.path,text);const candidate=structuredClone(before),hash=createHash('sha256').update(text).digest('hex');
 candidate.plans[0].source={...candidate.plans[0].source,version:'2',sha256:hash};
 const {trust,...source}=plan.source;
 await f.service.revise(f.grant.principal,{schemaVersion:'light-1.0',projectId:before.projects[0].id,planId:plan.id,expectedRevision:before.projects[0].revision,eventId:'source-revision-2',source,occurredAt:new Date().toISOString(),reason:'已确认仅更新方案说明，保留原执行与验收',snapshot:candidate});
 assert.equal(f.snapshot().plans[0].source.sha256,hash);return hash;
}

test('a registered source revision resumes at an accepted stage boundary without losing history',async t=>{
 const f=await fixture(t,{hold:true});await f.change('start');for(let i=0;i<100&&!f.requests.length;i++)await delay(10);
 await f.change('pause');f.release();await f.until('paused');
 const previous=f.p.read('lightContinuous').runs[0];assert.equal(previous.current,null);assert.equal(previous.history.length,1);
 const hash=await reviseSource(f);await f.change('resume');await f.until('completed');
 const fresh=f.p.read('lightContinuous').runs[0];assert.equal(fresh.sourceHash,hash);assert.equal(fresh.history.length,3);assert.equal(fresh.history[0].threadId,previous.history[0].threadId);assert.equal(f.created.length,3);
});

test('a source revision cannot replace the identity of an unaccepted running stage',async t=>{
 const f=await fixture(t,{hold:true});await f.change('start');for(let i=0;i<100&&!f.requests.length;i++)await delay(10);t.after(()=>f.release());
 const previous=f.p.read('lightContinuous').runs[0];await reviseSource(f);
 await assert.rejects(f.change('resume'),error=>error.status===409&&/SOURCE_REVISION_REVIEW/.test(error.message));
 const unchanged=f.p.read('lightContinuous').runs[0];assert.equal(unchanged.id,previous.id);assert.equal(unchanged.sourceHash,previous.sourceHash);assert.equal(unchanged.current.threadId,previous.current.threadId);assert.equal(unchanged.current.executionId,previous.current.executionId);assert.equal(f.created.length,1);
 await f.change('pause');f.release();await f.until('paused');
});

test('a source revision cannot silently restart an unaccepted blocked stage',async t=>{
 const f=await fixture(t,{finish:false});await f.change('start');await f.until('blocked');const previous=f.p.read('lightContinuous').runs[0];await reviseSource(f);
 await assert.rejects(f.change('resume'),error=>error.status===409&&/SOURCE_REVISION_REVIEW/.test(error.message));
 const unchanged=f.p.read('lightContinuous').runs[0];assert.equal(unchanged.status,'blocked');assert.equal(unchanged.id,previous.id);assert.equal(unchanged.current.threadId,previous.current.threadId);assert.equal(unchanged.current.executionId,previous.current.executionId);assert.equal(f.requests.length,1);
});

test('HTTP continuous start returns a specific source-change 409 without entering enabled state',async t=>{
 const f=await fixture(t),ownerToken='isolated-test-owner';f.runner.close();await writeFile(f.snapshot().plans[0].source.path,'changed');
 const server=await createServer({dataDir:path.join(f.root,'data'),env:{},lightAccessEnabled:true,continuousClientFactory:f.factory,continuousPrincipalProvider:()=>f.grant.principal,
  authorize(req){if(req.headers.authorization!==`Bearer ${ownerToken}`)throw new HttpError(403,'FORBIDDEN');}});
 try{
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const body=JSON.stringify({planKey:'test-plan',action:'start',mode:'stages',expectedRevision:f.snapshot().projects[0].revision,acknowledged:true});
 const response=await new Promise((resolve,reject)=>{const request=http.request({host:'127.0.0.1',port:server.address().port,path:'/api/light-continuous/change',method:'POST',headers:{Authorization:`Bearer ${ownerToken}`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));});request.on('error',reject);request.end(body);});
 assert.equal(response.status,409);assert.match(response.body.error,/SOURCE_CHANGED.*方案原文已变化/);assert.equal(f.created.length,0);assert.equal(server.workbench.persistence.read('lightContinuous').runs.length,0);
 }finally{await new Promise(resolve=>server.close(resolve));}
});


test('switching current-thread to staged and back follows the newly active stage chat',async t=>{
 const f=await fixture(t,{hold:[1,2]});await f.change('start','current_thread');for(let i=0;i<150&&!f.held.has(1);i++)await delay(10);t.after(()=>f.release());
 await f.change('pause');f.release();await f.until('paused');await f.change('resume','stages');for(let i=0;i<150&&!f.held.has(2);i++)await delay(10);
 assert.equal(f.created.length,2);assert.equal(f.requests[1].id,'chat-2');
 await f.change('pause');await f.change('resume','current_thread');for(let i=0;i<150&&!f.notifications.length;i++)await delay(10);
 assert.equal(f.notifications.length,1);assert.equal(f.notifications[0].id,'chat-2');assert.equal(f.runner.read()[0].threadId,'chat-2');
 f.release();await f.until('completed');assert.equal(f.created.length,2);assert.deepEqual(f.requests.map(item=>item.id),['chat-1','chat-2','chat-2']);
});


test('a resumed current chat with a different directory cannot receive the next stage',async t=>{
 const f=await fixture(t,{hold:true});await f.change('start','current_thread');for(let i=0;i<150&&!f.held.has(1);i++)await delay(10);
 await f.change('pause');f.release();await f.until('paused');f.runner.close();await mkdir(path.join(f.root,'moved-directory'));
 const runner=createContinuousRunner(f.p,f.service,{principalProvider:()=>f.grant.principal,clientFactory:options=>{const client=f.factory(options);client.resume=async id=>({thread:{id,cwd:path.join(f.root,'moved-directory')}});return client;}});await runner.initialize();t.after(()=>runner.close());
 await runner.change({planKey:'test-plan',action:'resume',mode:'current_thread',expectedRevision:f.snapshot().projects[0].revision,acknowledged:true});for(let i=0;i<700&&runner.read()[0].status==='running';i++)await delay(10);
 assert.equal(runner.read()[0].status,'blocked');assert.match(runner.read()[0].reason,/目录|上下文|CONTEXT_MISMATCH/);assert.equal(f.requests.length,1);assert.equal(f.created.length,1);assert.equal(f.snapshot().steps.find(step=>step.code==='B').status,'pending');
});


test('a delayed notification for an accepted stage cannot spill into its successor',async t=>{
 let releaseAttach,entered=false;const gate=new Promise(resolve=>{releaseAttach=resolve;});t.after(()=>releaseAttach());
 const f=await fixture(t,{hold:true,decorateClient:client=>{const attach=client.attach.bind(client);client.attach=async id=>{entered=true;await gate;return attach(id);};return client;}});
 await f.change('start','stages');for(let i=0;i<150&&!f.held.has(1);i++)await delay(10);t.after(()=>f.release());
 await f.change('pause');await f.change('resume','current_thread');for(let i=0;i<150&&!entered;i++)await delay(10);assert.equal(entered,true,'通知已进入原会话的异步连接检查');
 f.release();for(let i=0;i<150&&f.snapshot().steps.find(step=>step.code==='A').status!=='completed';i++)await delay(10);await delay(50);
 assert.equal(f.snapshot().steps.find(step=>step.code==='A').status,'completed');assert.equal(f.requests.length,1,'待确认的旧阶段通知结束前不能启动后继阶段');assert.equal(f.snapshot().steps.find(step=>step.code==='B').status,'pending');
 releaseAttach();await f.until('completed');assert.equal(f.notifications.length,0,'A已验收，过时的A指令必须丢弃');assert.equal(f.created.length,1);assert.deepEqual(f.requests.map(item=>item.id),['chat-1','chat-1','chat-1']);
});


test('an unknown notification remains a checkpoint after stage acceptance and cannot be resent',async t=>{
 let notificationCalls=0;
 const f=await fixture(t,{hold:true,decorateClient:client=>{client.notify=async()=>{notificationCalls++;throw Object.assign(Error('CODEX_DELIVERY_UNKNOWN'),{code:'CODEX_DELIVERY_UNKNOWN'});};return client;}});
 await f.change('start','stages');for(let i=0;i<150&&!f.held.has(1);i++)await delay(10);t.after(()=>f.release());
 await f.change('pause');await f.change('resume','current_thread');await f.until('blocked');assert.equal(notificationCalls,1);
 f.release();for(let i=0;i<200&&!f.p.read('lightContinuous').runs[0].history.length;i++)await delay(10);await f.until('blocked');
 assert.equal(f.snapshot().steps.find(step=>step.code==='A').status,'completed');assert.equal(f.p.read('lightContinuous').runs[0].current.delivery.state,'unknown');assert.equal(f.snapshot().steps.find(step=>step.code==='B').status,'pending');
 await f.change('resume','current_thread');await f.until('blocked');assert.equal(notificationCalls,1);assert.equal(f.requests.length,1);assert.equal(f.snapshot().steps.find(step=>step.code==='B').status,'pending');assert.equal(f.p.read('lightContinuous').runs[0].current.delivery.state,'unknown');
});
