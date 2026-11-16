// Date: 2026-11-16. Isolated native acceptance fixture; no production data, UI automation or model calls.
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createPersistence } from '../server/persistence.mjs';
import { createRequests } from '../server/business-requests.mjs';
import { createLightAccess } from '../server/light-access.mjs';
import { createLightService } from '../server/light-service.mjs';
import { prepareLightPlan } from '../server/light-import.mjs';
import { connectOwner } from '../desktop/client.mjs';
import { stopService } from '../desktop/service.mjs';
import { inspectWorkspace } from '../../plugins/task-workbench/skills/workbench-handoff/scripts/context-ledger.mjs';
import { writePrivateJson } from '../desktop/private-runtime.mjs';
const directory=fileURLToPath(new URL('../test-results/native-recovery/',import.meta.url));
const pointer=path.join(directory,'fixture.json');
const runtimeBase=path.join(os.tmpdir(),'task-island-native-recovery');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const action=process.argv[2];
await mkdir(directory,{recursive:true});
let fixture;
if(action==='prepare'){
  await mkdir(runtimeBase,{recursive:true});
  const root=await mkdtemp(path.join(runtimeBase,'runtime-'));
  const p=await createPersistence(root),access=createLightAccess(p),grant=await access.connect({appId:'codex',acknowledged:true});
  const service=createLightService(p,createRequests(p),{authorize:()=>true});
  const text='# 原生恢复验收\n日期：2026-11-16\n## 实施路线与出口\n| 阶段 | 前置 | 范围 | 出口 |\n| A 运行中任务 | 无 | 隔离状态 | 实际核验 |\n';
  const file=path.join(root,'plan.md');await writeFile(file,text);
  const observed=await inspectWorkspace(root);
  const context={sessionGroup:'A',threadId:'native-fixture-chat',hostId:'local',folderId:null,worktreeOrdinal:1,worktreePath:root,branch:observed.branch,head:observed.head,trust:'declared'};
  const candidate=prepareLightPlan({text,sourcePath:file,version:'1',projectKey:'native-recovery-project',planKey:'native-recovery-plan',name:'退出与恢复隔离验收',date:'2026-11-16',context});
  const registered=await service.register(grant.principal,{eventId:'register',expectedRevision:0,snapshot:candidate});
  const snapshot=()=>service.read(grant.principal,registered.projectId);
  const base=eventId=>{const s=snapshot(),{trust,...source}=s.plans[0].source;return{schemaVersion:'light-1.0',projectId:registered.projectId,planId:registered.planIds[0],expectedRevision:s.projects[0].revision,eventId,source,occurredAt:new Date().toISOString(),reason:'原生隔离验收'};};
  const binding={key:'native-binding',id:'native-binding-1',projectKey:candidate.projects[0].key,planKey:candidate.plans[0].key,stepKeys:snapshot().steps.map(step=>step.key),bindingRevision:1,state:'confirmed',context,confirmationRef:'fixture-confirmed',revokedAt:null};
  await service.acceptBinding(grant.principal,{...base('bind'),binding});
  const execution=await service.reserveExecutionId(grant.principal,base('reserve'));
  const start={...base('start'),stepId:snapshot().steps[0].id,executionId:execution.executionId,bindingId:binding.id,bindingRevision:1,targetStatus:'running',evidence:[],checks:[],blocker:null,reopen:null,successorImpact:null};
  await service.update(grant.principal,start);
  await writePrivateJson(path.join(root,'mcp-config.json'),{dataDir:root,token:grant.token});
  fixture={date:'2026-11-16',root,projectId:registered.projectId,start,snapshot:snapshot(),checks:[]};
  await writeFile(pointer,JSON.stringify(fixture,null,2));
  console.log(JSON.stringify({root,pointer}));
}else{
  fixture=JSON.parse(await readFile(pointer,'utf8'));
  const relative=path.relative(runtimeBase,fixture.root);
  if(!relative.startsWith('runtime-')||relative.includes(path.sep)||path.isAbsolute(relative))throw Error('INVALID_FIXTURE_ROOT');
  const root=fixture.root;
  const owner=()=>connectOwner(root);
  if(action==='record'){
    const current=await owner();fixture.ownerGeneration=current.record.ownerGeneration;
    const launcher=JSON.parse(await readFile(path.join(root,'launcher.json'),'utf8'));
    fixture.islandPid=launcher.pid;
    fixture.checks.push({action,at:new Date().toISOString(),ownerGeneration:fixture.ownerGeneration,islandPid:fixture.islandPid});
  }else if(action==='crash-service'||action==='crash-both'){
    const {record}=await owner();fixture.previousGeneration=record.ownerGeneration;
    if(action==='crash-both'){
      const launcher=JSON.parse(await readFile(path.join(root,'launcher.json'),'utf8'));
      if(launcher.pid!==fixture.islandPid)throw Error('FIXTURE_PID_CHANGED');
      process.kill(launcher.pid,'SIGKILL');
    }
    process.kill(record.pid,'SIGKILL');
    fixture.checks.push({action,at:new Date().toISOString()});
  }else if(action==='verify'||action==='recover-both'||action==='cancel'){
    if(action==='verify')for(let i=0;i<150;i++){
      try{const {record}=await owner();if(record.ownerGeneration!==fixture.previousGeneration)break;}catch{}
      await delay(100);
    }
    const client=new Client({name:'codex-native-recovery-fixture',version:'1'});
    const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../mcp/light-stdio.mjs',import.meta.url))],stderr:'pipe',env:{
      WORKBENCH_LIGHT_CONFIG:path.join(root,'mcp-config.json'),WORKBENCH_ISLAND_LAUNCHER:path.join(root,'launcher.json'),
      ISLAND_NATIVE_TEST_WINDOW:'1',ISLAND_NATIVE_TEST_SERVICE:'1',ISLAND_WORKBENCH_DATA_DIR:root,
      APPDATA:path.join(root,'appdata'),LOCALAPPDATA:path.join(root,'localappdata'),
    }});
    await client.connect(transport);
    try{
      const call=async(name,args)=>{const value=(await client.callTool({name,arguments:args})).structuredContent;if(value.status!=='accepted')throw Error(JSON.stringify(value));return value.result;};
      const snapshot=await call('workbench_get_project',{projectId:fixture.projectId});
      if(action==='cancel')await call('workbench_update_step_status',{...fixture.start,eventId:'native-cancel',expectedRevision:snapshot.projects[0].revision,targetStatus:'cancelled',successorImpact:'隔离验收已结束，无后继'});
      else{
        if(JSON.stringify(snapshot.executions)!==JSON.stringify(fixture.snapshot.executions)||JSON.stringify(snapshot.bindings)!==JSON.stringify(fixture.snapshot.bindings))throw Error('IDENTITY_CHANGED');
        const current=await owner();if(current.record.ownerGeneration===fixture.previousGeneration)throw Error('OWNER_NOT_RESTARTED');
        const event=await call('workbench_query_event',{projectId:fixture.projectId,operation:'update',eventId:'start'});
        if(event.state!=='committed')throw Error('EVENT_NOT_RECOVERED');
        const launcher=JSON.parse(await readFile(path.join(root,'launcher.json'),'utf8'));
        fixture.islandPid=launcher.pid;
        fixture.checks.push({action,at:new Date().toISOString(),ownerGeneration:current.record.ownerGeneration,identityPreserved:true,eventRecovered:true,islandPid:launcher.pid});
      }
    }finally{await client.close();}
  }else if(action==='stop'){
    await stopService(root);fixture.checks.push({action,at:new Date().toISOString()});
  }else throw Error('Expected prepare|record|crash-service|verify|crash-both|recover-both|cancel|stop');
  await writeFile(pointer,JSON.stringify(fixture,null,2));
  console.log(JSON.stringify({action,checks:fixture.checks}));
}
