// 日期：2026-11-16。验证旧版锁定、新版发布和必要验收替换的精确内容确认。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createPersistence} from './persistence.mjs';
import {createRequests} from './business-requests.mjs';
import {createLightService} from './light-service.mjs';
import {createLightPublication} from './light-publication.mjs';
import {prepareLightPlan} from './light-import.mjs';

async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'publication-revise-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const p=await createPersistence(root),requests=createRequests(p),service=createLightService(p,requests,{authorize:()=>true});
 const publisher=createLightPublication(p,requests,service,{authorize:()=>true,automaticPublication:()=>true});
 const snapshot=prepareLightPlan({text:'# 测试\n日期：2026-11-16\n## 实施路线与出口\n| 阶段 | 前置 | 范围 | 出口 |\n| A 准备 | 无 | 空 | 隔离目录成功 |\n| B 接续 | A | 空 | 成功 |\n',sourcePath:path.join(root,'plan.md'),version:'1',projectKey:'test/project',planKey:'test/plan',name:'修订测试',date:'2026-11-16',context:{sessionGroup:'test',threadId:null,hostId:null,folderId:null,worktreeOrdinal:1,worktreePath:root,branch:null,head:null,trust:'declared'}});
 const {trust,...source}=snapshot.plans[0].source;
 const registered=await publisher.publish('owner','register',{schemaVersion:'light-1.0',eventId:'register',expectedRevision:0,source,occurredAt:new Date().toISOString(),snapshot,confirmationGrant:null});
 const read=()=>service.read('owner',registered.projectId);
 const request=()=>{const before=read(),snapshot=structuredClone(before);snapshot.plans[0].source={...snapshot.plans[0].source,version:'2',sha256:'b'.repeat(64)};return {schemaVersion:'light-1.0',projectId:registered.projectId,planId:registered.planIds[0],expectedRevision:before.projects[0].revision,eventId:'revise',source,occurredAt:new Date().toISOString(),reason:'用户批准新版',snapshot,confirmationGrant:null};};
 return {p,service,publisher,read,request};
}

test('automatic revision locks the old source and publishes a different new source idempotently',async t=>{
 const f=await fixture(t),input=f.request(),before=f.read();
 const result=await f.publisher.publish('owner','revise',input);
 assert.deepEqual(await f.publisher.publish('owner','revise',input),result);
 assert.equal(f.read().plans[0].source.version,'2');assert.equal(f.read().projects[0].revision,before.projects[0].revision+1);
 assert.deepEqual(f.read().steps.map(s=>s.id),before.steps.map(s=>s.id));
});

test('new outer source and stale revision are rejected without changing the registered plan',async t=>{
 const f=await fixture(t),input=f.request(),before=f.read(),{trust,...newSource}=input.snapshot.plans[0].source;
 await assert.rejects(f.publisher.publish('owner','revise',{...input,eventId:'wrong-source',source:newSource}),{code:'STALE_PLAN'});
 await assert.rejects(f.publisher.confirm('owner','revise',{...input,expectedRevision:0}),{code:'REVISION_CONFLICT'});
 assert.deepEqual(f.read(),before);
});

test('required conditions need an exact owner confirmation even in automatic mode; history and IDs survive',async t=>{
 const f=await fixture(t),input=f.request(),before=f.read();
 input.snapshot.steps[0].conditions[0].text='同目录实际返回成功';
 await assert.rejects(f.publisher.publish('owner','revise',{...input,eventId:'unconfirmed'}),{code:'HISTORY_REQUIRED'});
 assert.deepEqual(f.read(),before);
 const {confirmationGrant}=await f.publisher.confirm('owner','revise',input);
 const confirmed={...input,confirmationGrant};
 const altered=structuredClone(confirmed);altered.reason='确认后偷偷更改内容';
 await assert.rejects(f.publisher.publish('owner','revise',altered),{code:'CONFIRMATION_REQUIRED'});
 await assert.rejects(f.publisher.publish('other','revise',confirmed),{code:'CONFIRMATION_REQUIRED'});
 const result=await f.publisher.publish('owner','revise',confirmed);
 assert.deepEqual(await f.publisher.publish('owner','revise',confirmed),result);
 const after=f.read();assert.equal(after.steps[0].conditions[0].text,'同目录实际返回成功');assert.equal(after.steps[0].conditions[0].result,'pending');
 assert.deepEqual(after.steps.map(s=>s.id),before.steps.map(s=>s.id));assert.deepEqual(after.steps.map(s=>s.dependsOn),before.steps.map(s=>s.dependsOn));
 const history=f.p.read('light').history.find(h=>h.eventId===input.eventId);
 assert.deepEqual(history.previousSteps,before.steps);assert.deepEqual(history.previousPlan,before.plans[0]);
});

test('expired or fabricated confirmation cannot fall back to automatic replacement',async t=>{
 const f=await fixture(t),input=f.request(),before=f.read();input.snapshot.steps[0].conditions[0].text='新版验收';
 const {confirmationGrant}=await f.publisher.confirm('owner','revise',input);
 await f.p.run(()=>{const grants=f.p.read('grants');grants[confirmationGrant].expiresAt=0;f.p.write('grants',grants);});
 for(const grant of [confirmationGrant,'fabricated'])await assert.rejects(f.publisher.publish('owner','revise',{...input,eventId:'bad-'+grant,confirmationGrant:grant}),{code:'CONFIRMATION_REQUIRED'});
 assert.deepEqual(f.read(),before);
});
