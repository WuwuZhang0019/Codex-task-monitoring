// 日期：2026-11-11。E接手、责任唯一、目录分支与迟到回执经真实HTTP及持久重开核验。
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from '../tests/helpers/light-e-fixture.mjs';

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
