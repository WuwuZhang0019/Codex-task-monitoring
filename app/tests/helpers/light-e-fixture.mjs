// 日期：2026-11-11。真实HTTP、真实临时Git工作树、受控确认及独立持久目录。
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from '../../server/index.mjs';
import {prepareLightPlan} from '../../server/light-import.mjs';
import {HttpError} from '../../server/validation.mjs';

export async function fixture(t){
 const parent=await mkdtemp(path.join(os.tmpdir(),'light-e-'));const root=path.resolve(parent);const repo=path.join(root,'worktree'),second=path.join(root,'second');await mkdir(repo);
 const git=args=>execFileSync('git',args,{windowsHide:true,encoding:'utf8',stdio:'pipe'}).trim();
 git(['init','-b','main',repo]);git(['-C',repo,'-c','user.name=E fixture','-c','user.email=e@example.invalid','commit','--allow-empty','-m','fixture']);git(['-C',repo,'worktree','add','-b','codex/second',second,'HEAD']);
 const head=git(['-C',repo,'rev-parse','HEAD']);const ownerToken=randomBytes(32).toString('hex'),transcript=[];let server,endpoint;
 async function open(){server=await createServer({dataDir:path.join(root,'data'),env:{},lightAccessEnabled:true,authorize(req,url){if(url==='/api/light-mcp')return;if(req.headers.authorization!=='Bearer '+ownerToken||req.headers.origin!==undefined)throw new HttpError(403,'FORBIDDEN');}});server.listen(0,'127.0.0.1');await once(server,'listening');endpoint='http://127.0.0.1:'+server.address().port;}
 async function close(){if(server?.listening){const closed=once(server,'close');server.close();server.closeAllConnections();await closed;}}
 await open();t.after(async()=>{
  if(process.env.E_EVIDENCE_DIR){await mkdir(process.env.E_EVIDENCE_DIR,{recursive:true});const safeName=Buffer.from(t.name).toString('base64url').slice(0,100);await writeFile(path.join(process.env.E_EVIDENCE_DIR,safeName+'.json'),JSON.stringify({date:'2026-11-11',name:t.name,environment:'独立真实HTTP、原生私有确认逻辑、两个临时Git工作树及持久重开',transcript},(key,value)=>['token','confirmationGrant'].includes(key)?'[redacted]':value,2)+'\n','utf8');}
  await close();assert.ok(root.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('light-e-'));await rm(root,{recursive:true,force:true});
 });
 async function ui(route,body,token=ownerToken){const response=await fetch(endpoint+'/api/light-access/'+route,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});const value=await response.json();transcript.push({route,status:response.status,value:structuredClone(value)});return {status:response.status,value};}
 async function grant(threadId,worktreeRoots=[repo,second]){const response=await ui('grants',{projectKeys:['E/project','E-linked/project'],threadId,hostId:'local',worktreeRoots,acknowledged:true});assert.equal(response.status,200,JSON.stringify(response));return {...response.value,threadId};}
 const old=await grant('old-thread'),next=await grant('next-thread');
 async function call(actor,name,args){const response=await fetch(endpoint+'/api/light-mcp',{method:'POST',headers:{Authorization:'Bearer '+actor.token,'Content-Type':'application/json'},body:JSON.stringify({name,arguments:args})});assert.equal(response.status,200);const wrapped=await response.json();const value=wrapped.structuredContent;transcript.push({name,input:structuredClone(args),result:structuredClone(value)});return value;}
 const accepted=value=>{assert.equal(value.status,'accepted',JSON.stringify(value));return value.result;};
 const context=(actor,branch='main')=>({sessionGroup:'E',threadId:actor.threadId,hostId:'local',folderId:'fixture-project',worktreeOrdinal:branch==='main'?1:2,worktreePath:branch==='main'?repo:second,branch,head,trust:'declared'});
 async function register(key='E'){
  const text='# E测试方案\n日期：2026-11-11\n## 实施路线与出口\n| 阶段 | 前置 | 范围 | 出口 |\n| A 准备 | 用户已确认 | 准备 | 准备证据完整 |\n| B 展示 | A | 展示 | 展示证据完整 |\n';
  const snapshot=prepareLightPlan({text,sourcePath:path.join(root,key+'.md'),version:'E-fixture',projectKey:key+'/project',planKey:key+'/plan',name:'E隔离测试',date:'2026-11-11',context:context(old)});
  const {trust,...source}=snapshot.plans[0].source;const input={schemaVersion:'light-1.0',expectedRevision:0,eventId:key+'/register',source,occurredAt:new Date().toISOString(),snapshot};const confirmation=await ui('confirm-publication',{principal:old.principal,operation:'register',input,acknowledged:true});assert.equal(confirmation.status,200);
  const request={...input,confirmationGrant:confirmation.value.confirmationGrant};const result=accepted(await call(old,'workbench_register_plan',request));assert.deepEqual(accepted(await call(old,'workbench_register_plan',request)),result);return {projectId:result.projectId,planId:result.planIds[0],source};
 }
 const main=await register();
 const read=async(p=main,actor=old)=>accepted(await call(actor,'workbench_get_project',{projectId:p.projectId}));
 async function base(event=randomUUID(),p=main){const snapshot=await read(p);return {schemaVersion:'light-1.0',projectId:p.projectId,planId:p.planId,source:p.source,expectedRevision:snapshot.projects.find(x=>x.id===p.projectId).revision,eventId:event,occurredAt:new Date().toISOString(),reason:'E隔离必要场景'};}
 async function propose(actor,stepIds,{takeover,branch='main',p=main}={}){const input={...await base(undefined,p),action:'propose',stepIds,context:context(actor,branch),bindingId:null,expectedBindingRevision:null,confirmationGrant:null,...(takeover?{takeover}:{})};const result=accepted(await call(actor,'workbench_bind_context',input));return {...input,...await base(undefined,p),action:'confirm',bindingId:result.bindingId,expectedBindingRevision:result.bindingRevision};}
 async function confirm(actor,input){const r=await ui('confirm-binding',{principal:actor.principal,input,acknowledged:true});assert.equal(r.status,200,JSON.stringify(r));return call(actor,'workbench_bind_context',{...input,confirmationGrant:r.value.confirmationGrant});}
 async function bind(actor,stepIds,options={}){return accepted(await confirm(actor,await propose(actor,stepIds,options)));}
 async function update(actor,step,binding,executionId,targetStatus='running',extra={},p=main){const input={...await base(undefined,p),stepId:step.id,executionId,bindingId:binding.bindingId,bindingRevision:binding.bindingRevision,targetStatus,evidence:[],checks:[],blocker:null,reopen:null,successorImpact:null,...extra};return {input,result:await call(actor,'workbench_update_step_status',input)};}
 async function start(actor,step,binding,p=main){const reservation=accepted(await call(actor,'workbench_reserve_execution',await base(undefined,p)));return update(actor,step,binding,reservation.executionId,'running',{},p);}
 return {root,repo,second,old,next,call,ui,accepted,context,register,main,read,base,propose,confirm,bind,update,start,transcript,reopen:async()=>{await close();await open();}};
}
