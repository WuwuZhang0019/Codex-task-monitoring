// 日期：2026-11-13。原生UI与真实HTTP/领域集成夹具；阶段执行器为模拟，不使用正式方案或模型会话。
import {mkdtemp,writeFile,mkdir,access} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import {randomBytes,randomUUID} from 'node:crypto';import {once} from 'node:events';
import {createServer,HttpError} from '../server/index.mjs';
import {prepareLightPlan} from '../server/light-import.mjs';
import {writePrivateJson,preparePrivateDirectory} from '../desktop/private-runtime.mjs';
const root=await mkdtemp(path.join(os.tmpdir(),'task-island-native-')),cwd=path.join(root,'project'),data=path.join(root,'data');await mkdir(cwd);
const token=randomBytes(32).toString('hex'),generation=randomUUID();let principal,registered,serial=0;
const server=await createServer({dataDir:data,env:{},lightAccessEnabled:true,continuousPrincipalProvider:()=>principal,continuousClientFactory:()=>({
 async create(cwd){return{id:'native-fixture-'+(++serial),cwd};},async resume(){},close(){},
 async run(threadId,text,onStarted){await onStarted?.('fixture-turn-'+serial);while(process.env.WORKBENCH_NATIVE_HOLD==='1'){try{await access(path.join(root,'release-stage'));break;}catch{await new Promise(r=>setTimeout(r,100));}}await new Promise(r=>setTimeout(r,1000));
 const service=server.workbench.light,s=service.read(principal,registered.projectId),binding=s.bindings.find(b=>b.context.threadId===threadId&&b.state==='confirmed'),step=s.steps.find(s=>binding.stepKeys.includes(s.key)&&s.status==='running'),execution=s.executions.find(e=>e.key===step.executionKey);const {trust,...source}=s.plans[0].source;
 const proof={evidenceId:'native-proof-'+step.code,location:'fixture://'+step.code,method:'isolated native fixture result',deliveryVersion:'1',result:'passed'};
 await service.update(principal,{schemaVersion:'light-1.0',projectId:registered.projectId,planId:registered.planIds[0],expectedRevision:s.projects[0].revision,eventId:'native-complete-'+step.code,source,occurredAt:new Date().toISOString(),reason:'原生界面夹具通过',stepId:step.id,executionId:execution.id,bindingId:binding.id,bindingRevision:binding.bindingRevision,targetStatus:'completed',evidence:[proof],checks:step.conditions.map(c=>({...c,result:'passed',evidenceIds:[proof.evidenceId]})),blocker:null,reopen:null,successorImpact:null});return{status:'completed'};
 }}),authorize(req,url){if(url!=='/api/light-mcp'&&req.headers.authorization!==`Bearer ${token}`)throw new HttpError(403,'FORBIDDEN');}});
server.listen(0,'127.0.0.1');await once(server,'listening');const endpoint=`http://127.0.0.1:${server.address().port}`;
const result=await fetch(endpoint+'/api/light-access/connect',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({appId:'codex',acknowledged:true})});principal=(await result.json()).principal;
const file=path.join(cwd,'plan.md'),text='# 原生界面测试\n日期：2026-11-13\n## 实施路线与出口\n| 阶段 | 前置 | 范围 | 出口 |\n| A 第一步 | 无 | 空 | 成功 |\n| B 第二步 | A | 空 | 成功 |\n| C 第三步 | B | 空 | 成功 |\n';await writeFile(file,text);
registered=await server.workbench.light.register(principal,{eventId:'native-register',expectedRevision:0,snapshot:prepareLightPlan({text,sourcePath:file,version:'1',projectKey:'native-project',planKey:'native-plan',name:'连续执行原生界面测试',date:'2026-11-13',context:{sessionGroup:'test',threadId:null,hostId:null,folderId:null,worktreeOrdinal:1,worktreePath:cwd,branch:null,head:null,trust:'declared'}})});
await preparePrivateDirectory(path.join(data,'runtime-private'));for(const file of ['owner-session.json','panel-session.json'])await writePrivateJson(path.join(data,'runtime-private',file),{version:1,ownerGeneration:generation,token});await writeFile(path.join(data,'owner.json'),JSON.stringify({version:1,ownerGeneration:generation,endpoint,pid:process.pid}));
const output={date:'2026-11-13',root,data,endpoint};await writeFile('test-results/continuous-button/native-fixture.json',JSON.stringify(output));console.log(JSON.stringify(output));
process.stdin.setEncoding('utf8');process.stdin.on('data',async input=>{if(input.trim()==='stop'){server.closeAllConnections();await new Promise(r=>server.close(r));console.log('NATIVE_FIXTURE_CLOSED');}});
