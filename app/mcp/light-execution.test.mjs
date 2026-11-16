// 日期：2026-11-11。E接手、责任唯一、目录分支与迟到回执经真实HTTP及持久重开核验。
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from '../tests/helpers/light-e-fixture.mjs';
import {buildGrowingRouteRevision} from '../../plugins/task-workbench/skills/workbench-handoff/scripts/growing-route.mjs';
import {bindingProposal} from '../../plugins/task-workbench/skills/workbench-handoff/scripts/binding-request.mjs';

// Date: 2026-11-17. A chat may continue one child while the previous chat retains its siblings and parent execution.
test('所选步骤接续保留其他责任、原执行与迟到回执，持久重开不恢复旧写权',async t=>{
 const f=await fixture(t);let s=await f.read();const root=s.steps[0];
 for(const taskKey of ['one','two']){
  const {request}=buildGrowingRouteRevision(s,{planId:f.main.planId,headingKey:root.key,taskKey,title:taskKey,acceptance:'verified',sourceLocator:'fixture/'+taskKey,eventId:'grow/'+taskKey,reason:'明确的独立工作'});
  const confirmed=await f.ui('confirm-publication',{principal:f.old.principal,operation:'revise',input:request,acknowledged:true});
  f.accepted(await f.call(f.old,'workbench_revise_plan',{...request,confirmationGrant:confirmed.value.confirmationGrant}));s=await f.read();
 }
 const [one,two]=s.steps.filter(x=>x.parentKey===root.key),old=await f.bind(f.old,[root.id,s.steps[1].id]);
 const parentStart=await f.start(f.old,root,old),first=await f.start(f.old,one,old),second=await f.start(f.old,two,old);
 const oneExecution=f.accepted(first.result).executionId;
 const proposal=bindingProposal(await f.read(),f.context(f.next),{eventId:'selected-proposal',planId:f.main.planId,stepIds:[one.id]});
 assert.deepEqual(proposal.stepIds,[one.id]);assert.deepEqual(proposal.takeover.executionIds,[oneExecution]);assert.equal(proposal.takeover.scope,'selected');
 const before=await f.read();const missing=await f.propose(f.next,[one.id],{takeover:{...proposal.takeover,executionIds:[]}});
 const beforeConfirm=await f.read();assert.equal((await f.confirm(f.next,missing)).error.code,'STALE_EXECUTION');assert.deepEqual(await f.read(),beforeConfirm);
 const next=await f.bind(f.next,[one.id],{takeover:proposal.takeover});s=await f.read();
 const retained=s.bindings.find(b=>b.id===old.bindingId),moved=s.bindings.find(b=>b.id===next.bindingId);
 assert.equal(retained.state,'confirmed');assert.deepEqual(retained.excludedStepKeys,[one.key]);assert.equal(retained.bindingRevision,old.bindingRevision+1);
 assert.equal(s.executions.find(e=>e.id===oneExecution).bindingKey,moved.key);
 for(const result of [parentStart,second])assert.equal(s.executions.find(e=>e.id===f.accepted(result.result).executionId).bindingKey,retained.key);
 assert.equal(s.executions.length,before.executions.length);assert.deepEqual(s.steps.map(x=>[x.id,x.status]),before.steps.map(x=>[x.id,x.status]));
 const stale=await f.update(f.old,one,old,oneExecution);assert.equal(stale.result.error.code,'STALE_BINDING');
 assert.equal(f.accepted(await f.call(f.old,'workbench_query_event',{projectId:f.main.projectId,operation:'update',eventId:stale.input.eventId})).state,'pendingReview');
 const refreshed={bindingId:old.bindingId,bindingRevision:retained.bindingRevision};
 assert.equal((await f.update(f.old,one,refreshed,oneExecution)).result.error.code,'STALE_BINDING','刷新旧版本也不能重新获得已转移子步骤');
 f.accepted((await f.update(f.old,two,refreshed,f.accepted(second.result).executionId)).result);
 f.accepted((await f.update(f.next,one,next,oneExecution)).result);
 assert.equal((await f.update(f.next,two,next,f.accepted(second.result).executionId)).result.error.code,'STALE_BINDING');
 await f.reopen();s=await f.read();assert.deepEqual(s.bindings.find(b=>b.id===old.bindingId).excludedStepKeys,[one.key]);assert.equal(s.executions.length,3);
 assert.throws(()=>bindingProposal(s,f.context(f.next),{eventId:'no-scope',planId:f.main.planId}),/EXPLICIT_STEP_SCOPE_REQUIRED/);
 const attempt=await f.propose(f.next,[one.id],{takeover:{fromBindingId:old.bindingId,expectedBindingRevision:retained.bindingRevision,executionIds:[],scope:'selected'}});
 assert.equal((await f.confirm(f.next,attempt)).error.code,'STALE_BINDING','不能从旧绑定再次获取已排除责任');
});

test('E 显式接手保留executionId，旧新责任唯一，迟到结果持久待核对',async t=>{
 const f=await fixture(t),s=await f.read(),step=s.steps[0];const old=await f.bind(f.old,[step.id]);const started=await f.start(f.old,step,old);const executionId=f.accepted(started.result).executionId;
 const takeover={fromBindingId:old.bindingId,expectedBindingRevision:old.bindingRevision,executionIds:[executionId]};const next=await f.bind(f.next,[step.id],{takeover,branch:'codex/second'});
 let snapshot=await f.read();assert.equal(snapshot.bindings.filter(x=>x.state==='confirmed').length,1);assert.equal(snapshot.executions[0].id,executionId);assert.equal(snapshot.executions[0].bindingKey,snapshot.bindings.find(x=>x.id===next.bindingId).key);
 assert.deepEqual(f.accepted(await f.call(f.old,'workbench_update_step_status',started.input)),f.accepted(started.result),'已提交旧事件仍可原键回放');
 const before=snapshot.projects[0].revision;const late=await f.update(f.old,step,old,executionId);assert.equal(late.result.error.code,'STALE_BINDING');assert.equal((await f.read()).projects[0].revision,before);
 const query={projectId:f.main.projectId,operation:'update',eventId:late.input.eventId};assert.equal(f.accepted(await f.call(f.old,'workbench_query_event',query)).state,'pendingReview');
 const current=await f.update(f.next,step,next,executionId);assert.equal(f.accepted(current.result).executionId,executionId);
 await f.reopen();snapshot=await f.read();assert.equal(snapshot.executions.length,1);assert.equal(snapshot.executions[0].id,executionId);assert.equal(f.accepted(await f.call(f.old,'workbench_query_event',query)).result.status,'pendingReview');
});
test('E 接手必须核对原责任全部范围及未结束执行，确认意图不能偷换',async t=>{
 const f=await fixture(t),s=await f.read(),step=s.steps[0];const old=await f.bind(f.old,s.steps.map(x=>x.id));const started=await f.start(f.old,step,old);const executionId=f.accepted(started.result).executionId;
 const request=await f.propose(f.next,[step.id],{takeover:{fromBindingId:old.bindingId,expectedBindingRevision:old.bindingRevision,executionIds:[executionId]}});
 const before=(await f.read()).projects[0].revision;const bad=await f.confirm(f.next,request);assert.equal(bad.error.code,'STALE_BINDING');assert.equal((await f.read()).projects[0].revision,before);
 const missing=await f.propose(f.next,s.steps.map(x=>x.id),{takeover:{fromBindingId:old.bindingId,expectedBindingRevision:old.bindingRevision,executionIds:[]}});assert.equal((await f.confirm(f.next,missing)).error.code,'STALE_EXECUTION');
 const changed={...missing,takeover:{...missing.takeover,executionIds:[executionId]}};const ui=await f.ui('confirm-binding',{principal:f.next.principal,input:changed,acknowledged:true});assert.ok(ui.status>=400);
});
test('E 重叠责任拒绝，未认证确认、错误目录和分支不生效',async t=>{
 const f=await fixture(t),s=await f.read(),step=s.steps[0];await f.bind(f.old,[step.id]);const request=await f.propose(f.next,[step.id]);assert.equal((await f.confirm(f.next,request)).error.code,'DUPLICATE_OWNER');
 const fake=await f.ui('confirm-binding',{principal:f.next.principal,input:request,acknowledged:true},f.next.token);assert.equal(fake.status,403);
 const wrong={...request,context:{...request.context,branch:'wrong'}};assert.ok((await f.ui('confirm-binding',{principal:f.next.principal,input:wrong,acknowledged:true})).status>=400);
 const outside={...request,context:{...request.context,worktreePath:f.root}};assert.ok((await f.ui('confirm-binding',{principal:f.next.principal,input:outside,acknowledged:true})).status>=400);
});
