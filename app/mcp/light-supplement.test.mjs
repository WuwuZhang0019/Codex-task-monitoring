// 日期：2026-11-11。补充事项受控确认、规划、独立阻塞和取消承接的真实HTTP验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from '../tests/helpers/light-e-fixture.mjs';

async function supplement(f,step,extra={}){return {...await f.base(),action:'create',supplementId:null,sourceStepId:step.id,title:'独立事项',goal:'原方案外独立交付',blocksSource:true,status:'unconfirmed',linkedPlanId:null,repairId:'legacy-repair-17',evidence:[],...extra};}
async function confirmed(f,input){const r=await f.ui('confirm-supplement',{principal:f.old.principal,input,acknowledged:true});assert.equal(r.status,200,JSON.stringify(r));return {...input,confirmationGrant:r.value.confirmationGrant};}
async function complete(f,step,binding,id,p=f.main){const evidence=[{evidenceId:step.id+'/proof',location:'fixture://E/'+step.code,method:'真实HTTP必要验收',deliveryVersion:'E-fixture',result:'passed'}];const checks=step.conditions.map(c=>({...c,result:'passed',evidenceIds:[evidence[0].evidenceId]}));return f.accepted((await f.update(f.old,step,binding,id,'completed',{evidence,checks},p)).result);}

test('E 事项确认绑定精确内容，关联方案完成只解除对应阻塞并保留repairId',async t=>{
 const f=await fixture(t),s=await f.read(),step=s.steps[0],binding=await f.bind(f.old,[step.id]);const id=f.accepted((await f.start(f.old,step,binding)).result).executionId;
 const blocker={blockerId:'external',reason:'另一个独立等待',waitingFor:['external'],releaseConditions:['外部完成'],resolved:false};f.accepted((await f.update(f.old,step,binding,id,'blocked',{blocker})).result);
 const create=await supplement(f,step);const created=f.accepted(await f.call(f.old,'workbench_record_supplement',create));assert.deepEqual(f.accepted(await f.call(f.old,'workbench_record_supplement',create)),created);
 const planning=await supplement(f,step,{...await f.base(),action:'update',supplementId:created.supplementId,status:'unplanned'});assert.equal((await f.call(f.old,'workbench_record_supplement',planning)).error.code,'FORBIDDEN');
 assert.ok((await f.ui('confirm-supplement',{principal:f.old.principal,input:planning,acknowledged:false})).status>=400);
 assert.equal((await f.ui('confirm-supplement',{principal:f.old.principal,input:planning,acknowledged:true},f.old.token)).status,403);
 const approved=await confirmed(f,planning);assert.equal((await f.call(f.old,'workbench_record_supplement',{...approved,goal:'换目标'})).error.code,'FORBIDDEN');f.accepted(await f.call(f.old,'workbench_record_supplement',approved));
 const linked=await f.register('E-linked');const linkedSnapshot=await f.read(linked);const linkedBinding=await f.bind(f.old,linkedSnapshot.steps.map(x=>x.id),{p:linked});
 const link=await supplement(f,step,{...await f.base(),action:'linkPlan',supplementId:created.supplementId,status:'running',linkedPlanId:linked.planId});f.accepted(await f.call(f.old,'workbench_record_supplement',link));
 for(const linkedStep of linkedSnapshot.steps){const started=f.accepted((await f.start(f.old,linkedStep,linkedBinding,linked)).result);await complete(f,linkedStep,linkedBinding,started.executionId,linked);}
 const current=await f.read(linked),evidence=current.steps.filter(x=>x.planKey===linkedSnapshot.plans[0].key).flatMap(x=>x.evidence);
 const resolve=await supplement(f,step,{...await f.base(),action:'resolve',supplementId:created.supplementId,status:'completed',linkedPlanId:linked.planId,evidence});f.accepted(await f.call(f.old,'workbench_record_supplement',resolve));
 let after=await f.read();const source=after.steps.find(x=>x.id===step.id);assert.equal(source.status,'blocked');assert.equal(source.blockers.find(x=>x.blockerId==='external').resolved,false);assert.equal(source.blockers.find(x=>x.blockerId==='supplement:'+created.supplementId).resolved,true);assert.equal(after.supplements[0].repairId,'legacy-repair-17');
 f.accepted((await f.update(f.old,step,binding,id,'running',{blocker:{...blocker,resolved:true}})).result);assert.equal((await f.read()).steps.find(x=>x.id===step.id).status,'running');await complete(f,step,binding,id);
 await f.reopen();after=await f.read();assert.equal(after.steps.find(x=>x.id===step.id).acceptance,'passed');assert.equal(after.supplements[0].status,'completed');
});
test('E 必要事项取消须受控确认和明确承接，解除后仍核对来源自身验收',async t=>{
 const f=await fixture(t),step=(await f.read()).steps[0],binding=await f.bind(f.old,[step.id]);const id=f.accepted((await f.start(f.old,step,binding)).result).executionId;
 const created=f.accepted(await f.call(f.old,'workbench_record_supplement',await supplement(f,step)));let cancel=await supplement(f,step,{...await f.base(),action:'cancel',supplementId:created.supplementId,status:'cancelled',reason:'取消另行安排'});
 assert.equal((await f.call(f.old,'workbench_record_supplement',cancel)).error.code,'FORBIDDEN');assert.ok((await f.ui('confirm-supplement',{principal:f.old.principal,input:cancel,acknowledged:true})).status>=400);
 cancel={...cancel,cancellationHandoff:'原步骤承接原验收所需工作，独立新增目标不实施'};f.accepted(await f.call(f.old,'workbench_record_supplement',await confirmed(f,cancel)));
 const after=await f.read();assert.equal(after.supplements[0].status,'cancelled');assert.equal(after.steps[0].status,'running');assert.notEqual(after.steps[0].acceptance,'passed');await complete(f,step,binding,id);
});
test('E 执行取消与显式返工、阻塞恢复沿用绑定并重检前置',async t=>{
 const f=await fixture(t),step=(await f.read()).steps[0],binding=await f.bind(f.old,[step.id]);const id=f.accepted((await f.start(f.old,step,binding)).result).executionId;
 f.accepted((await f.update(f.old,step,binding,id,'cancelled',{successorImpact:'后继保持pending，用户重新授权原步骤返工'})).result);
 assert.equal((await f.update(f.old,step,binding,id,'running')).result.error.code,'REOPEN_REQUIRED');
 f.accepted((await f.update(f.old,step,binding,id,'running',{reopen:{reason:'恢复原验收',successorImpact:'后继仍等待本步骤验收'}})).result);
 const blocker={blockerId:'waiting-user',reason:'等待核对',waitingFor:['user'],releaseConditions:['核对完成'],resolved:false};f.accepted((await f.update(f.old,step,binding,id,'blocked',{blocker})).result);assert.equal((await f.update(f.old,step,binding,id)).result.error.code,'BLOCKER_NOT_RESOLVED');f.accepted((await f.update(f.old,step,binding,id,'running',{blocker:{...blocker,resolved:true}})).result);await complete(f,step,binding,id);
});
