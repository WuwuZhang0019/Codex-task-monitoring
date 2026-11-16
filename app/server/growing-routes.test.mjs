// 日期：2026-11-16。隔离持久化与 MCP：动态追加、历史补录及业务门禁。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createPersistence} from './persistence.mjs';
import {createRequests} from './business-requests.mjs';
import {createLightService} from './light-service.mjs';
import {createLightAccess} from './light-access.mjs';
import {createLightPublication} from './light-publication.mjs';
import {prepareLightPlan} from './light-import.mjs';
import {createLightHandler, validateLightToolArguments} from '../mcp/light.mjs';
import {buildGrowingRouteRevision} from '../../plugins/task-workbench/skills/workbench-handoff/scripts/growing-route.mjs';

async function fixture(t) {
 const root=await mkdtemp(path.join(os.tmpdir(),'growing-routes-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const p=await createPersistence(root),access=createLightAccess(p),{principal}=await access.connect({acknowledged:true});
 const service=createLightService(p,createRequests(p),{authorize:access.authorize,automaticBinding:access.automaticBinding,verifyExecutionContext:access.verifyExecutionContext});
 const publisher=createLightPublication(p,createRequests(p),service,{authorize:access.authorize,automaticPublication:access.automaticPublication});
 const handler=createLightHandler({service,authenticate:()=>principal,publish:publisher.publish});
 const context={sessionGroup:'test',threadId:'fixture-thread',hostId:'local',folderId:null,worktreeOrdinal:1,worktreePath:root,branch:null,head:null,trust:'declared'};
 const snapshot=prepareLightPlan({text:'# 动态路线\n日期：2026-11-16\n## 实施路线与出口\n| 阶段 | 前置 | 范围 | 出口 |\n| A 服务 | 无 | 按实际确定 | 必要验收通过 |\n| B 集成 | 无 | 按实际确定 | 必要验收通过 |\n',sourcePath:path.join(root,'plan.md'),version:'1',projectKey:'growing/project',planKey:'growing/plan',name:'动态路线',date:'2026-11-16',context});
 snapshot.routes=snapshot.steps.map((step,i)=>({...snapshot.routes[0],key:'route/'+step.code,label:step.title,order:i+1,stepKeys:[step.key]}));
 const {trust,...source}=snapshot.plans[0].source;
 const registered=await publisher.publish(principal,'register',{schemaVersion:'light-1.0',eventId:'register',expectedRevision:0,source,occurredAt:new Date().toISOString(),snapshot,confirmationGrant:null});
 const read=()=>service.read(principal,registered.projectId);
 const base=eventId=>({schemaVersion:'light-1.0',projectId:registered.projectId,planId:registered.planIds[0],source,eventId,expectedRevision:read().projects[0].revision,occurredAt:new Date().toISOString(),reason:'隔离用户授权动态步骤'});
 const grow=(taskKey,extra={})=>buildGrowingRouteRevision(read(),{planId:registered.planIds[0],headingKey:snapshot.steps[0].key,taskKey,title:'实际工作 '+taskKey,acceptance:'定向验收通过',sourceLocator:'fixture-turn/'+taskKey,eventId:'grow/'+taskKey,reason:'用户明确本次实际步骤',...extra});
 const call=async request=>{
  assert.deepEqual(validateLightToolArguments('workbench_revise_plan',request),[]);
  return (await handler.callTool({params:{name:'workbench_revise_plan',arguments:request}})).structuredContent;
 };
 const proof=(result='passed',deliveryVersion='fixture-v1')=>({evidenceId:'proof',location:'fixture://verified-output',method:'隔离断言，非真实业务证据',deliveryVersion,result});
 const bind=async()=>service.bind(principal,{...base('bind'),action:'propose',bindingId:null,expectedBindingRevision:null,confirmationGrant:null,stepIds:[read().steps[0].id],context});
 const update=async(stepKey,status,binding,extra={})=>{
  const step=read().steps.find(s=>s.key===stepKey);
  const executionId=read().executions.find(item=>item.key===step.executionKey)?.id ?? (await service.reserveExecutionId(principal,base('reserve-'+step.code))).executionId;
  return service.update(principal,{...base('update-'+step.code+'-'+status),bindingId:binding.bindingId,bindingRevision:binding.bindingRevision,executionId,stepId:step.id,targetStatus:status,checks:[],evidence:[],blocker:null,reopen:null,successorImpact:null,...extra});
 };
 return {p,access,principal,service,publisher,read,base,grow,call,proof,bind,update};
}

test('追加实际步骤、请求重放与同任务重试保留身份，不预造未知节点',async t=>{
 const f=await fixture(t),initial=f.read();assert.equal(initial.steps.length,2);
 const first=f.grow('actual-1'),result=await f.call(first.request);assert.equal(result.status,'accepted');
 const after=f.read(),child=after.steps.find(s=>s.key===first.stepKey);
 assert.equal(child.status,'pending');assert.ok(child.id);assert.equal(child.code,'A-01');assert.deepEqual(after.routes,initial.routes);
 assert.deepEqual(await f.call(first.request),result);assert.deepEqual(f.read(),after);
 const retry=f.grow('actual-1');assert.equal(retry.request,null);assert.equal(retry.stepId,child.id);
 const second=f.grow('actual-2');assert.equal((await f.call(second.request)).status,'accepted');
 assert.equal(f.read().steps.find(s=>s.key===second.stepKey).code,'A-02');
 assert.deepEqual(f.read().steps.find(s=>s.key===second.stepKey).dependsOn,[],'展示顺序不伪造前置');
 const binding=await f.bind();await f.update(initial.steps[0].key,'running',binding);await f.update(child.key,'running',binding);
 assert.equal(f.grow('actual-1').request,null);assert.equal(f.read().steps.length,4);assert.equal(f.read().executions.length,2);
});

test('历史完成补录不创建开始事件或 executionId，未知原时间仍为 null',async t=>{
 const f=await fixture(t),change=f.grow('history',{history:{status:'completed',evidence:[f.proof()],occurredAt:null}});
 assert.equal((await f.call(change.request)).status,'accepted');
 const after=f.read(),step=after.steps.find(s=>s.key===change.stepKey);
 assert.equal(step.status,'completed');assert.equal(step.acceptance,'passed');assert.equal(step.executionKey,null);
 assert.equal(after.executions.length,0);assert.equal(after.bindings.length,0);assert.equal(after.events.length,1);
 assert.ok(!after.events.some(e=>e.toStatus==='running'));assert.equal(after.events[0].executionKey,null);
 assert.equal(change.request.historicalSteps[0].occurredAt,null);
 assert.equal(f.p.read('light').history.find(h=>h.input?.historicalSteps)?.input.historicalSteps[0].occurredAt,null);
 assert.equal(f.p.read('light').history.find(h=>h.eventId===change.request.eventId).previousSteps.length,2);
 assert.equal((await f.call(change.request)).status,'accepted');assert.equal(f.read().steps.length,3);
});

test('证据不足拒绝完成且整笔回滚；历史未核验为 recheck，核验后沿用原节点',async t=>{
 const f=await fixture(t),bad=f.grow('bad',{history:{status:'completed',evidence:[]}}),before=f.read();
 assert.equal((await f.call(bad.request)).error.code,'EVIDENCE_MISMATCH');assert.deepEqual(f.read(),before);
 const uncertain=f.grow('uncertain',{history:{status:'pending',evidence:[f.proof('pending')]}});
 assert.equal((await f.call(uncertain.request)).status,'accepted');
 const step=f.read().steps.find(s=>s.key===uncertain.stepKey);assert.equal(step.status,'pending');assert.equal(step.acceptance,'recheck');
 const finish=f.grow('unused',{existingStepKey:step.key,eventId:'verify-history',history:{status:'completed',evidence:[f.proof()]}});
 assert.equal((await f.call(finish.request)).status,'accepted');assert.equal(f.read().steps.find(s=>s.key===step.key).id,step.id);
});

test('真实跨线依赖必须先验收；不为补历史而清除前置',async t=>{
 const f=await fixture(t),a=f.grow('service');assert.equal((await f.call(a.request)).status,'accepted');
 const heading=f.read().steps.find(s=>s.code==='B');
 const blocked=f.grow('integration',{headingKey:heading.key,dependsOn:[a.stepKey],history:{status:'completed',evidence:[f.proof()]}});
 const before=f.read();assert.equal((await f.call(blocked.request)).error.code,'DEPENDENCY_NOT_READY');assert.deepEqual(f.read(),before);
 const finish=f.grow('service',{eventId:'service-history',history:{status:'completed',evidence:[f.proof()]}});
 assert.equal((await f.call(finish.request)).status,'accepted');
 const b=f.grow('integration',{headingKey:heading.key,dependsOn:[a.stepKey],history:{status:'completed',evidence:[f.proof()]}});
 assert.equal((await f.call(b.request)).status,'accepted');assert.deepEqual(f.read().steps.find(s=>s.key===b.stepKey).dependsOn,[a.stepKey]);
});

test('历史补录不能改写进行中步骤或另一应用的责任绑定',async t=>{
 const f=await fixture(t),a=f.grow('active');assert.equal((await f.call(a.request)).status,'accepted');
 const binding=await f.bind();await f.update(f.read().steps[0].key,'running',binding);await f.update(a.stepKey,'running',binding);
 const before=f.read(),history=f.grow('active',{eventId:'bad-history',history:{status:'completed',evidence:[f.proof()]}});
 assert.equal((await f.call(history.request)).error.code,'INVALID_TRANSITION');assert.deepEqual(f.read(),before);
 const pending=f.grow('other-history',{history:{status:'pending',evidence:[f.proof('pending')]}});
 const {principal:other}=await f.access.connect({appId:'claude-code',acknowledged:true});
 await assert.rejects(f.publisher.publish(other,'revise',pending.request),{code:'FORBIDDEN'});assert.deepEqual(f.read(),before);
});

test('并行追加冲突后保留原实体和状态；换内容复用键拒绝',async t=>{
 const f=await fixture(t),a=f.grow('one'),b=f.grow('two');assert.equal((await f.call(a.request)).status,'accepted');const after=f.read();
 assert.equal((await f.call(b.request)).error.code,'REVISION_CONFLICT');assert.deepEqual(f.read(),after);
 const conflict=structuredClone(a.request);conflict.reason='换内容复用原键';assert.equal((await f.call(conflict)).error.code,'IDEMPOTENCY_CONFLICT');
 assert.deepEqual(f.read(),after);assert.throws(()=>f.grow('wrong',{existingStepKey:'missing'}),/EXISTING_STEP_NOT_FOUND/);
});


test('向进行中标题追加实际步骤不阻塞整条线；已完成标题新增必要工作则保留历史并复核',async t=>{
 const f=await fixture(t),first=f.grow('historical',{history:{status:'completed',evidence:[f.proof()]}});
 assert.equal((await f.call(first.request)).status,'accepted');
 const binding=await f.bind(),heading=f.read().steps[0];await f.update(heading.key,'running',binding);
 const next=f.grow('current');assert.equal((await f.call(next.request)).status,'accepted');
 assert.equal(f.read().steps[0].status,'running');assert.equal(f.read().steps[0].blockers.length,0);
 const finish=f.grow('current',{eventId:'finish-current-history',history:{status:'completed',evidence:[f.proof()]}});
 assert.equal((await f.call(finish.request)).status,'accepted');
 const checks=heading.conditions.map(c=>({...c,result:'passed',evidenceIds:['proof']}));
 await f.update(heading.key,'completed',binding,{checks,evidence:[f.proof()]});
 const completed=f.read().steps[0];assert.equal(completed.status,'completed');
 const past=f.grow('already-finished',{history:{status:'completed',evidence:[f.proof()]}});
 assert.equal((await f.call(past.request)).status,'accepted');
 assert.equal(f.read().steps[0].status,'completed','补录已验收历史不得撤销原阶段完成');
 const extra=f.grow('new-required');assert.equal((await f.call(extra.request)).status,'accepted');
 const reviewed=f.read().steps[0];assert.equal(reviewed.id,completed.id);assert.equal(reviewed.status,'blocked');
 assert.deepEqual(reviewed.evidence,completed.evidence);assert.equal(reviewed.acceptance,'recheck');
 assert.equal(f.read().executions.length,1,'历史补录和结构增长不虚构执行');
});


test('已有多条件步骤补录须逐项明确检查，不能从一句已完成自动全通过',async t=>{
 const f=await fixture(t),change=f.grow('multiple');assert.equal((await f.call(change.request)).status,'accepted');
 const edit=f.grow('another');const item=edit.request.snapshot.steps.find(s=>s.key===change.stepKey);
 item.conditions.push({conditionId:change.stepKey+'/second',text:'第二项独立验收',required:true,result:'pending',evidenceIds:[]});
 assert.equal((await f.call(edit.request)).status,'accepted');
 assert.throws(()=>f.grow('multiple',{eventId:'cannot-infer',history:{status:'completed',evidence:[f.proof()]}}),/EXPLICIT_HISTORY_CHECKS_REQUIRED/);
 const step=f.read().steps.find(s=>s.key===change.stepKey);
 const explicit=f.grow('multiple',{eventId:'explicit-checks',history:{status:'completed',evidence:[f.proof()],checks:step.conditions.map(c=>({...c,result:'passed',evidenceIds:['proof']}))}});
 assert.equal((await f.call(explicit.request)).status,'accepted');
 assert.equal(f.read().steps.find(s=>s.key===step.key).id,step.id);
});
