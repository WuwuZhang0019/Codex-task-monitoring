// 日期：2026-11-13。显式授权的真实模型/公开app-server/独立HTTP与MCP验收，不写正式业务数据。
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {stepPassed} from '../server/light-model.mjs';
import os from 'node:os';import path from 'node:path';import {once} from 'node:events';import {fileURLToPath} from 'node:url';
import {createServer,HttpError} from '../server/index.mjs';
import {CodexSessionClient} from '../server/codex-session-client.mjs';
import {registrationSnapshot,sha256} from '../../plugins/task-workbench/skills/workbench-handoff/scripts/normalize-plan.mjs';
if(process.env.WORKBENCH_CONTINUOUS_LIVE!=='1')throw Error('Set WORKBENCH_CONTINUOUS_LIVE=1 for explicit live acceptance');
const mode=process.env.WORKBENCH_CONTINUOUS_MODE??'stages';
if(!['stages','current_thread'].includes(mode))throw Error('WORKBENCH_CONTINUOUS_MODE must be stages or current_thread');
const scenario=process.env.WORKBENCH_CONTINUOUS_SCENARIO??'full';
if(!['full','minimal'].includes(scenario))throw Error('WORKBENCH_CONTINUOUS_SCENARIO must be full or minimal');
const root=await mkdtemp(path.join(os.tmpdir(),'task-island-live-')),cwd=path.join(root,'project');await mkdir(cwd);
const dataDir=path.join(root,'data'),bridgeConfig=path.join(root,'bridge.json'),ownerToken='e'.repeat(64);
const output=fileURLToPath(new URL('../test-results/continuous-button/'+(mode==='current_thread'?(scenario==='minimal'?'live-current-thread-minimal-result.json':'live-current-thread-result.json'):(scenario==='minimal'?'live-stages-minimal-result.json':'live-result.json')),import.meta.url));
await mkdir(path.dirname(output),{recursive:true});
let principal,server,passed=false;
const clients=[];
const factory=()=>{const c=new CodexSessionClient({threadConfig:{plugins:{'task-workbench@task-workbench-u01-local':{enabled:false}},mcp_servers:{task_island_isolated:{command:process.execPath,args:[fileURLToPath(new URL('../mcp/light-stdio.mjs',import.meta.url))],env:{WORKBENCH_LIGHT_CONFIG:bridgeConfig}}}}});clients.push(c);return c;};
try{
 server=await createServer({dataDir,env:{},lightAccessEnabled:true,continuousClientFactory:factory,continuousPrincipalProvider:()=>principal,
 authorize(req,url){if(url!=='/api/light-mcp'&&req.headers.authorization!==`Bearer ${ownerToken}`)throw new HttpError(403,'FORBIDDEN');}});
 server.listen(0,'127.0.0.1');await once(server,'listening');const endpoint=`http://127.0.0.1:${server.address().port}`;
 const post=async(url,body)=>{const r=await fetch(endpoint+url,{method:'POST',headers:{Authorization:`Bearer ${ownerToken}`,'Content-Type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(JSON.stringify(v));return v;};
 const grant=await post('/api/light-access/connect',{appId:'codex',acknowledged:true});principal=grant.principal;await writeFile(bridgeConfig,JSON.stringify({endpoint,token:grant.token}),{mode:0o600});
 const text=scenario==='minimal'?'# 同会话最小连续执行隔离测试\n日期：2026-11-13\n状态：待执行\n仅包含两个主阶段A和B，均为空任务：在当前目录写入该阶段成功JSON作为证据，然后按工作台条件完成本阶段验收。A成功并验收后由任务岛在同一会话派发B。没有子步骤，没有等待，不创建子代理。不要修改其他目录。\n':'# 连续执行隔离测试\n日期：2026-11-13\n状态：待执行\n各阶段及子步骤均为空任务，仅返回成功，无等待。A成功后执行B，B依次执行B-01、B-02、B-03；B-03成功后才能判定B成功，再执行C。执行证据保存到当前目录的JSON文件。不要修改其他目录。\n';
 const file=path.join(cwd,'plan.md');await writeFile(file,text);
 const planKey='continuous-live/plan',projectKey='continuous-live/project';
 const fullNodes=[['A',null,1,[]],['B',null,2,['A']],['C',null,3,['B']],['B-01','B',1,[]],['B-02','B',2,['B-01']],['B-03','B',3,['B-02']]];
 const selectedNodes=scenario==='minimal'?[['A',null,1,[]],['B',null,2,['A']]]:fullNodes;
 const nodes=selectedNodes.map(([code,parentKey,order,dependsOn])=>({key:planKey+'/'+code,parentKey:parentKey?planKey+'/'+parentKey:null,code,originalCode:code,title:code==='B'&&scenario==='full'?'第二步及三个子步骤':code,locator:code,order,dependsOn:dependsOn.map(code=>planKey+'/'+code),acceptance:'实际执行空任务并返回成功'+(code==='B'&&scenario==='full'?'，三个必要子步骤均成功':'')}));
 const snapshot=registrationSnapshot({date:'2026-11-13',afterSha256:sha256(text),mapping:nodes},{projectKey,planKey,name:'连续执行隔离验收',sourcePath:file,version:'1',context:{sessionGroup:'test',threadId:null,hostId:null,folderId:null,worktreeOrdinal:1,worktreePath:cwd,branch:null,head:null,trust:'declared'}});
 const registered=await server.workbench.light.register(principal,{eventId:'register',expectedRevision:0,snapshot});
 const result=await post('/api/light-continuous/change',{planKey,action:'start',mode,expectedRevision:registered.revision,acknowledged:true});console.log(JSON.stringify(result));
 const timeoutMs=Number(process.env.WORKBENCH_CONTINUOUS_TIMEOUT_MS??(mode==='current_thread'?1800000:600000));
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<=0)throw Error('WORKBENCH_CONTINUOUS_TIMEOUT_MS must be a positive integer');
 const deadline=Date.now()+timeoutMs;let last='';let report;
 while(Date.now()<deadline){
  const r=await fetch(endpoint+'/api/light-panel',{headers:{Authorization:`Bearer ${ownerToken}`}});const p=await r.json();const run=p.continuousRuns[0];
  const signature=JSON.stringify(run);if(signature!==last){console.log(signature);last=signature;}
  if(run&&['completed','blocked','paused'].includes(run.status)){report={date:'2026-11-13',live:true,mode,scenario,root,run,steps:p.snapshot.steps.map(s=>({code:s.code,status:s.status,acceptance:s.acceptance})),runs:server.workbench.persistence.read('lightContinuous')};break;}
  await new Promise(r=>setTimeout(r,1000));
 }
 if(!report){const state=server.workbench.persistence.read('light'),runs=server.workbench.persistence.read('lightContinuous');await writeFile(output,JSON.stringify({date:'2026-11-13',live:true,mode,scenario,root,error:'LIVE_ACCEPTANCE_TIMEOUT',steps:state.snapshot.steps.map(step=>({code:step.code,status:step.status,acceptance:step.acceptance})),runs},null,2));throw Error('LIVE_ACCEPTANCE_TIMEOUT');}await writeFile(output,JSON.stringify(report,null,2));
 if(report.run.status!=='completed')throw Error('LIVE_NOT_COMPLETE: '+report.run.reason);
 const final=server.workbench.persistence.read('light').snapshot,history=report.runs.runs[0].history;
 const expectedCodes=scenario==='minimal'?['A','B']:['A','B','B-01','B-02','B-03','C'],expectedStages=scenario==='minimal'?['A','B']:['A','B','C'];
 assert.equal(report.steps.length,expectedCodes.length);assert.deepEqual(report.steps.map(step=>step.code).sort(),expectedCodes);
 assert.ok(final.steps.every(step=>stepPassed(final,step)),'各主阶段及子步骤必须有真实通过的验收证据');
 assert.equal(history.length,expectedStages.length);assert.deepEqual(history.map(item=>final.steps.find(step=>step.key===item.stepKey)?.code),expectedStages);
 assert.equal(new Set(history.map(item=>item.threadId)).size,mode==='current_thread'?1:expectedStages.length,'会话数量必须匹配所选连续执行方式');
 passed=true;console.log('LIVE_ACCEPTANCE_PASSED: '+mode+' / '+scenario);
}finally{for(const c of clients)c.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}if(passed)await rm(bridgeConfig,{force:true});}
