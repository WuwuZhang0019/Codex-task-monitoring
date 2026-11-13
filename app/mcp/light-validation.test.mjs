// 日期：2026-11-13。重放真实失败请求，校验逐字段反馈及脚本生成候选。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {validateLightToolArguments,createLightHandler,lightTools} from './light.mjs';
import {bindingProposal,executionContext} from '../../plugins/task-workbench/skills/workbench-handoff/scripts/binding-request.mjs';
import {registrationSnapshot} from '../../plugins/task-workbench/skills/workbench-handoff/scripts/normalize-plan.mjs';
const failed=JSON.parse(await readFile(new URL('../tests/fixtures/invalid-registration-20261113.json',import.meta.url),'utf8'));
test('execution context reads the actual command environment and reports distinct missing prerequisites',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'binding-identity-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const context=await executionContext(directory,{CODEX_THREAD_ID:'fixture-thread'});
 assert.equal(context.threadId,'fixture-thread');assert.equal(context.hostId,'local');assert.equal(context.branch,null);
 await assert.rejects(executionContext(directory,{}),/CURRENT_THREAD_ID_REQUIRED/);
 assert.throws(()=>bindingProposal({mode:'local'},context,{eventId:'bind'}),/SERVICE_SNAPSHOT_REQUIRED/);
 assert.throws(()=>bindingProposal({mode:'service'},context,{eventId:''}),/NONEMPTY_EVENT_ID_REQUIRED/);
 assert.throws(()=>bindingProposal({mode:'service'},{...context,threadId:null},{eventId:'bind'}),/CURRENT_THREAD_ID_REQUIRED/);
});
test('binding and updates expose concrete fields while retaining strict conditional checks',()=>{
 const tool=lightTools.find(t=>t.name==='workbench_bind_context');
 assert.equal(tool.inputSchema.allOf,undefined);assert.ok(tool.inputSchema.properties.context.properties.threadId);
 assert.ok(lightTools.find(t=>t.name==='workbench_update_step_status').inputSchema.properties.stepId);
 const context={sessionGroup:'A',threadId:'real-thread',hostId:'local',folderId:null,worktreeOrdinal:1,worktreePath:'G:\\rust\\test',branch:null,head:null,trust:'declared'};
 const snapshot={...failed.snapshot,mode:'service',projects:failed.snapshot.projects.map(p=>({...p,id:'project-id',revision:1})),plans:failed.snapshot.plans.map(p=>({...p,id:'plan-id',source:{...p.source,sha256:p.source.sha256.toLowerCase()}})),steps:failed.snapshot.steps.map(s=>({...s,id:s.key+'-id'}))};
 const proposal=bindingProposal(snapshot,context,{eventId:'bind-event'});
 assert.deepEqual(validateLightToolArguments('workbench_bind_context',proposal),[]);
 assert.ok(validateLightToolArguments('workbench_bind_context',{...proposal,confirmationGrant:'incorrect'}).length);
 assert.ok(validateLightToolArguments('workbench_bind_context',{}).some(e=>e.path==='/eventId'));
 assert.throws(()=>bindingProposal(snapshot,context,{eventId:''}));
});
test('real failed registration reports all invalid field paths without echoing supplied values or executing a write',async()=>{
 const issues=validateLightToolArguments('workbench_register_plan',failed);
 const paths=issues.map(i=>i.path);
 for(const path of ['/source/sha256','/snapshot/plans/0/endConditions/0','/snapshot/steps/0/acceptance','/snapshot/routes/0/id','/snapshot/routes/0/context'])assert.ok(paths.includes(path),path);
 let authenticated=0;
 const handler=createLightHandler({service:{},authenticate:()=>{authenticated++;return 'fixture';}});
 await assert.rejects(handler.callTool({params:{name:'workbench_register_plan',arguments:failed}}),error=>error.data.validationErrors.length===issues.length);
 assert.equal(authenticated,0);
 assert.ok(!JSON.stringify(issues).includes(failed.source.sha256));
});
test('registrationSnapshot produces valid enums, structured contexts, conditions, routes and lowercase hash for the same three-step case',()=>{
 const projectKey='test-g-rust-test',planKey='test-plan-01';
 const mapping=['A','B','C'].map((code,i)=>({key:code,code,originalCode:code,parentKey:null,title:code,locator:'步骤/'+code,order:i+1,dependsOn:i?[['A','B'][i-1]]:[],acceptance:i===1?'实际等待至少10秒后返回成功':'返回成功'}));
 const snapshot=registrationSnapshot({date:'2026-11-13',mapping,afterSha256:failed.source.sha256.toLowerCase()},{projectKey,planKey,name:'测试方案01',sourcePath:failed.source.path,version:'2026-11-13',context:{sessionGroup:'A',threadId:null,hostId:null,folderId:null,worktreeOrdinal:1,worktreePath:'G:\\rust\\test',branch:null,head:null,trust:'declared'}});
 assert.deepEqual(validateLightToolArguments('workbench_register_plan',{...failed,source:{...failed.source,sha256:failed.source.sha256.toLowerCase()},snapshot}),[]);
});
