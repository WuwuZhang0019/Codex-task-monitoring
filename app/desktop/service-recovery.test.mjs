// Date: 2026-11-16. Real owner process termination; task state is an isolated fixture, with no model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLightBridge } from '../mcp/light-bridge.mjs';
import { createPersistence } from '../server/persistence.mjs';
import { createRequests } from '../server/business-requests.mjs';
import { createLightAccess } from '../server/light-access.mjs';
import { createLightService } from '../server/light-service.mjs';
import { prepareLightPlan } from '../server/light-import.mjs';
import { startService, stopService } from './service.mjs';
import { connectOwner } from './client.mjs';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('normal service exit is rejected while active; forced termination recovers the same execution and original event', {timeout:30000}, async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'island-real-recovery-'));
  let record;
  t.after(async()=>{
    try{await stopService(root);}catch{if(record)try{process.kill(record.pid,'SIGKILL');}catch{}}
    await delay(150);await rm(root,{recursive:true,force:true});
  });
  const persistence=await createPersistence(root),accessControl=createLightAccess(persistence);
  const grant=await accessControl.connect({appId:'codex',acknowledged:true});
  const service=createLightService(persistence,createRequests(persistence),{authorize:()=>true});
  const text='# 隔离测试\n日期：2026-11-16\n## 实施路线与出口\n| 阶段 | 前置 | 范围 | 出口 |\n| A 第一步 | 无 | 空 | 成功 |\n';
  const file=path.join(root,'plan.md');await writeFile(file,text);
  const context={sessionGroup:'A',threadId:'original-chat',hostId:'local',folderId:null,worktreeOrdinal:1,worktreePath:root,branch:null,head:null,trust:'declared'};
  const candidate=prepareLightPlan({text,sourcePath:file,version:'1',projectKey:'recovery-project',planKey:'recovery-plan',name:'隔离恢复测试',date:'2026-11-16',context});
  const registered=await service.register(grant.principal,{eventId:'register',expectedRevision:0,snapshot:candidate});
  const snapshot=()=>service.read(grant.principal,registered.projectId);
  const base=eventId=>{const s=snapshot(),{trust,...source}=s.plans[0].source;return{schemaVersion:'light-1.0',projectId:registered.projectId,planId:registered.planIds[0],expectedRevision:s.projects[0].revision,eventId,source,occurredAt:new Date().toISOString(),reason:'隔离进程恢复验证'};};
  const binding={key:'recovery-binding',id:'binding-1',projectKey:candidate.projects[0].key,planKey:candidate.plans[0].key,stepKeys:snapshot().steps.map(step=>step.key),bindingRevision:1,state:'confirmed',context,confirmationRef:'fixture-confirmed',revokedAt:null};
  await service.acceptBinding(grant.principal,{...base('bind'),binding});
  const execution=await service.reserveExecutionId(grant.principal,base('reserve'));
  const start={...base('start'),stepId:snapshot().steps[0].id,executionId:execution.executionId,bindingId:binding.id,bindingRevision:1,targetStatus:'running',evidence:[],checks:[],blocker:null,reopen:null,successorImpact:null};
  await service.update(grant.principal,start);
  const before=snapshot();
  record=await startService(root);
  const manager=await connectOwner(root);
  const status=await fetch(`${record.endpoint}/api/runtime/exit-status`,{headers:{Authorization:`Bearer ${manager.token}`}}).then(r=>r.json());
  assert.equal(status.allowed,false);assert.equal(status.activeExecutions,1);
  await assert.rejects(stopService(root),/TASK_ACTIVE/);
  assert.equal((await connectOwner(root)).record.ownerGeneration,record.ownerGeneration);
  await assert.rejects(access(path.join(root,'stopped.json')),{code:'ENOENT'});
  const firstGeneration=record.ownerGeneration;
  process.kill(record.pid,'SIGKILL');
  for(let i=0;i<100;i++){try{await connectOwner(root);}catch{break;}await delay(20);}
  let recoveries=0;
  const bridge=createLightBridge({dataDir:root,token:grant.token},{recovery:{ensure:async check=>{
    try{return await check();}catch{recoveries++;record=await startService(root);return check();}
  }},journalDirectory:path.join(root,'bridge-events')});
  const client=new Client({name:'codex-crash-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  await bridge.connect(b);await client.connect(a);t.after(async()=>{await client.close();await bridge.close();});
  const call=async(name,args)=>{const value=(await client.callTool({name,arguments:args})).structuredContent;assert.equal(value.status,'accepted',JSON.stringify(value));return value.result;};
  const after=await call('workbench_get_project',{projectId:registered.projectId});
  assert.equal(recoveries,1);assert.notEqual(record.ownerGeneration,firstGeneration);
  assert.deepEqual(after.executions,before.executions);assert.deepEqual(after.bindings,before.bindings);assert.equal(after.projects[0].revision,before.projects[0].revision);
  const event=await call('workbench_query_event',{projectId:registered.projectId,operation:'update',eventId:'start'});
  assert.equal(event.state,'committed');assert.equal(event.result.executionId,execution.executionId);
  // Date: 2026-11-17. A user pause must permit normal stop and retain the original execution on restart.
  const paused=await call('workbench_update_step_status',{...start,eventId:'pause',expectedRevision:after.projects[0].revision,targetStatus:'blocked',blocker:{blockerId:'user-pause',reason:'用户暂停',waitingFor:['用户继续'],releaseConditions:['明确继续后恢复原执行'],resolved:false}});
  await stopService(root);
  record=await startService(root);
  const checkpoint=await call('workbench_get_project',{projectId:registered.projectId});
  assert.equal(checkpoint.projects[0].revision,paused.revision);
  assert.equal(checkpoint.steps[0].status,'blocked');
  assert.equal(checkpoint.executions[0].id,execution.executionId);
  assert.equal(checkpoint.executions[0].endedAt,null);
  // The original chat may resume directly with the saved blocker details.
  await call('workbench_update_step_status',{...start,eventId:'direct-resume',expectedRevision:checkpoint.projects[0].revision,
    blocker:{...checkpoint.steps[0].blockers[0],resolved:true}});
  const running=await call('workbench_get_project',{projectId:registered.projectId});
  assert.equal(running.steps[0].status,'running');
  const owner = await connectOwner(root);
  const change=async (action,s)=> {
    const response=await fetch(`${record.endpoint}/api/light-library/${action}`,{method:'POST',
      headers:{Authorization:`Bearer ${owner.token}`,'Content-Type':'application/json'},
      body:JSON.stringify({key:s.plans[0].key,expectedRevision:s.revision,acknowledged:true})});
    assert.equal(response.status,200,await response.text());
  };
  await change('pause',running);
  await change('resume',await call('workbench_get_project',{projectId:registered.projectId}));
  await stopService(root);
  record=await startService(root);
  const waiting=await call('workbench_get_project',{projectId:registered.projectId});
  assert.equal(waiting.steps[0].status,'blocked');
  assert.equal(waiting.steps[0].blockers[0].resolved,true);
  const resumed=await call('workbench_update_step_status',{...start,eventId:'resume-after-island',expectedRevision:waiting.projects[0].revision});
  assert.equal(resumed.executionId,execution.executionId);
  await assert.rejects(stopService(root),/TASK_ACTIVE/);
  const cancel={...start,eventId:'cancel',expectedRevision:resumed.revision,targetStatus:'cancelled',successorImpact:'隔离测试结束，无后继任务'};
  await call('workbench_update_step_status',cancel);
  await stopService(root);
});
