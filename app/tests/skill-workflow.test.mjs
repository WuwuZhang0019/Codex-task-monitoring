// 日期：2026-11-11。以独立原文验证编号、引用、插入和文件冲突行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {normalizePlan,sha256,applyNormalizedFile,registrationSnapshot} from '../../plugins/task-workbench/skills/workbench-handoff/scripts/normalize-plan.mjs';
import {validateLightSnapshot} from '../server/light-model.mjs';
import {folderName,executionTitle,recordMapping,runHostOperation,inspectWorktree} from '../../plugins/task-workbench/skills/workbench-handoff/scripts/context-ledger.mjs';

function input(text='# 方案\n日期：2026-11-11\n## N01 准备\n### 1 提取\n### 2 校验\n## N02 展示\n依赖 N01；验收保持完整。\n```mermaid\nflowchart TD\n n[N01 准备] --> m[N02 展示]\n```\n普通列表 1. 保持原样\n'){
 const range=(value,start=0)=>{const i=text.indexOf(value,start);return {start:i,end:i+value.length,expected:value};};
 const n1=text.indexOf('## N01'),n2=text.indexOf('## N02');
 return {text,expectedSha256:sha256(text),nodes:[{key:'prepare',parentKey:null,originalCode:'N01',title:'准备',locator:'准备',order:1,dependsOn:[],codeRange:range('N01',n1)},{key:'extract',parentKey:'prepare',originalCode:'1',title:'提取',locator:'准备/提取',order:1,dependsOn:[],codeRange:range('1',text.indexOf('### 1'))},{key:'check',parentKey:'prepare',originalCode:'2',title:'校验',locator:'准备/校验',order:2,dependsOn:['extract'],codeRange:range('2',text.indexOf('### 2'))},{key:'display',parentKey:null,originalCode:'N02',title:'展示',locator:'展示',order:2,dependsOn:['prepare'],codeRange:range('N02',n2)}],references:[{...range('N01',text.indexOf('依赖')),targetKey:'prepare'},{...range('N01',text.indexOf(' n[')),targetKey:'prepare'},{...range('N02',text.indexOf(' -->')),targetKey:'display'}]};
}
test('E 任意旧编号、依赖及Mermaid精确改写，内容与普通列表保留',()=>{
 const r=normalizePlan(input());assert.deepEqual(r.mapping.map(n=>n.code),['A','B','A-01','A-02']);assert.match(r.text,/## A 准备/);assert.match(r.text,/依赖 A；验收保持完整/);assert.match(r.text,/n\[A 准备\] --> m\[B 展示\]/);assert.match(r.text,/普通列表 1\. 保持原样/);
 const again=input(r.text); // 重新按当前源位置构造，编号身份复用。
 const nodes=r.mapping.map(m=>{const start=r.text.indexOf(m.parentKey?'### '+m.code:'## '+m.code)+(m.parentKey?4:3);return {...m,codeRange:{start,end:start+m.code.length,expected:m.code}};});
 const repeated=normalizePlan({text:r.text,expectedSha256:r.afterSha256,nodes,previous:r.mapping});assert.equal(repeated.text,r.text);assert.equal(repeated.edits.length,0);assert.equal(again.text,r.text);
});
test('E 已登记stepId与编号保持，插入使用锚点后缀并保留显式顺序',()=>{
 const first=normalizePlan(input());first.mapping.find(n=>n.key==='check').stepId='service-check';
 const text=first.text.replace('### A-02 校验','### NEW 补查\n### A-02 校验');
 const nodes=first.mapping.map(m=>{const prefix=m.parentKey?'### ':'## ',start=text.indexOf(prefix+m.code)+prefix.length;return {...m,order:m.key==='check'?3:m.order,codeRange:{start,end:start+m.code.length,expected:m.code}};});
 const start=text.indexOf('NEW');nodes.push({key:'insert',parentKey:'prepare',title:'补查',locator:'准备/补查',order:2,insertAfterKey:'extract',dependsOn:['extract'],codeRange:{start,end:start+3,expected:'NEW'}});
 const r=normalizePlan({text,expectedSha256:sha256(text),nodes,previous:first.mapping});assert.equal(r.mapping.find(n=>n.key==='insert').code,'A-01-a');assert.equal(r.mapping.find(n=>n.key==='check').stepId,'service-check');assert.equal(r.mapping.find(n=>n.key==='check').code,'A-02');
});
test('E 原编号重复按父作用域区分，超过Z仍可分配',()=>{
 const text=Array.from({length:27},(_,i)=>'## old'+i+' 阶段\n### 1 子项\n').join('');const nodes=[];
 for(let i=0;i<27;i++){const start=text.indexOf('old'+i+' '),child=text.indexOf('### 1',start)+4;nodes.push({key:'s'+i,title:'阶段',locator:'stage/'+i,parentKey:null,order:i+1,codeRange:{start,end:start+('old'+i).length,expected:'old'+i}},{key:'c'+i,title:'子项',locator:'child/'+i,parentKey:'s'+i,originalCode:'1',order:1,codeRange:{start:child,end:child+1,expected:'1'}});}
 const r=normalizePlan({text,expectedSha256:sha256(text),nodes});assert.equal(r.mapping.find(n=>n.key==='s26').code,'AA');assert.equal(r.mapping.find(n=>n.key==='c26').code,'AA-01');
});
test('E 模糊身份、缺失依赖、循环、重叠引用及并发来源变化拒绝',()=>{
 for(const mutate of [x=>x.expectedSha256='bad',x=>x.nodes[0].order=1.5,x=>x.nodes[0].order=0,x=>x.nodes[0].dependsOn=['unknown'],x=>x.nodes[0].dependsOn=['display'],x=>x.references.push({...x.nodes[0].codeRange,targetKey:'prepare'}),x=>x.nodes[1].parentKey='missing']){const x=input();mutate(x);assert.throws(()=>normalizePlan(x));}
 const x=input();x.previous=[{key:'removed',parentKey:null,code:'C'}];assert.throws(()=>normalizePlan(x),/HISTORY_REQUIRED/);
});
test('E 文件写回前重检来源，并发修改保留用户内容',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'e-normalize-'));try{const file=path.join(root,'plan.md'),x=input(),r=normalizePlan(x);await writeFile(file,x.text);await applyNormalizedFile(file,r);assert.equal(await readFile(file,'utf8'),r.text);await writeFile(file,'用户并发修改');await assert.rejects(applyNormalizedFile(file,r),/SOURCE_CHANGED/);assert.equal(await readFile(file,'utf8'),'用户并发修改');}finally{await rm(root,{recursive:true,force:true});}
});
test('E 规范化产物可登记为冻结契约候选，未保存不捏造服务ID',()=>{
 const x=input();for(const n of x.nodes)n.acceptance=n.title+'必要验收';const r=normalizePlan(x);
 const s=registrationSnapshot(r,{projectKey:'E/project',planKey:'E/plan',name:'E登记案例',sourcePath:'G:\\fixture\\plan.md',version:'source-1',context:{sessionGroup:'E',threadId:null,hostId:null,folderId:null,worktreeOrdinal:1,worktreePath:'G:\\fixture',branch:'main',head:null,trust:'declared'}});
 assert.equal(validateLightSnapshot(s),s);assert.ok(s.steps.every(n=>n.id===null));assert.equal(s.plans[0].source.sha256,r.afterSha256);assert.deepEqual(registrationSnapshot(r,{projectKey:'E/project',planKey:'E/plan',name:'E登记案例',sourcePath:'G:\\fixture\\plan.md',version:'source-1',context:s.routes[0].context}),s);
});
test('E 单文件夹、多工作树、超过九序号、同名会话及标题切换保持固定身份',()=>{
 assert.equal(folderName({planName:'方案'}),'方案');assert.equal(folderName({planName:'方案',branch:'codex/ui',ordinal:12,multipleWorktrees:true}),'1️⃣2️⃣ 方案 · codex/ui');
 assert.equal(executionTitle('开始执行⑤ 轻量路线工作台 / E Skill 与会话关联。\n继续'),'⑤ 轻量路线工作台 / E Skill 与会话关联');assert.equal(executionTitle('开始执行⑥ 项目 / F。'),'⑥ 项目 / F');
 const ledger={};for(const threadId of ['same-title-1','same-title-2'])recordMapping(ledger,{planKey:'plan',stepKeys:['A-01','A-02'],threadId,hostId:'local',hostProjectId:'fixed-project',worktreePath:'G:\\fixture',branch:'codex/ui',title:'同名'});
 assert.equal(ledger.mappings.length,2);recordMapping(ledger,{...ledger.mappings[0].mapping,title:'新名',branch:'codex/renamed'});assert.equal(ledger.mappings.length,2);assert.equal(ledger.mappingHistory.length,1);
});
test('E 宿主创建、改名与移动失败重试复用operationId和固定目标',async()=>{
 const ledger={},create={operationId:'create-1',kind:'createProject',name:'方案'};let created=0;
 const adapter={createProject:async()=>({targetId:'project-'+(++created)}),rename:async op=>{if(!op.reuseTargetId)throw Object.assign(Error('TEMPORARY'),{targetId:'fixed'});return {targetId:op.reuseTargetId};}};
 assert.equal((await runHostOperation(ledger,create,adapter)).status,'succeeded');await runHostOperation(ledger,create,adapter);assert.equal(created,1);
 const rename={operationId:'rename-1',kind:'rename',targetId:'fixed',name:'新名'};assert.equal((await runHostOperation(ledger,rename,adapter)).status,'failed');assert.equal((await runHostOperation(ledger,rename,adapter)).status,'succeeded');assert.equal(ledger.operations[1].attempts.length,2);
 await assert.rejects(runHostOperation(ledger,{...rename,name:'另一新名'},adapter),/IDEMPOTENCY_CONFLICT/);
 assert.equal((await runHostOperation(ledger,{operationId:'jump',kind:'jump'})).status,'unsupported');assert.equal((await runHostOperation(ledger,{operationId:'chat',kind:'createChat'},{createChat:async()=>{throw Error('must not run');}})).status,'unsupported');
});
test('E 掉响应创建先查询原operationId，恢复固定目标后不重复创建',async()=>{
 const ledger={},op={operationId:'unknown-create',kind:'createProject',name:'方案'};let calls=0;const adapter={createProject:async()=>{calls++;throw Object.assign(Error('DROPPED'),{resultUnknown:true});}};
 assert.equal((await runHostOperation(ledger,op,adapter)).status,'pending');await runHostOperation(ledger,op,adapter);assert.equal(calls,1);
 adapter.reconcile=async e=>({state:'succeeded',targetId:'already-created'});assert.equal((await runHostOperation(ledger,op,adapter)).targetId,'already-created');assert.equal(calls,1);
 const partial={operationId:'partial-create',kind:'createProject',name:'另一方案'},other={createProject:async()=>{throw Object.assign(Error('FOLLOWUP_FAILED'),{targetId:'created-before-failure'});}};
 assert.equal((await runHostOperation(ledger,partial,other)).status,'failed');assert.equal((await runHostOperation(ledger,partial,other)).status,'pending');
 other.reconcile=async()=>({state:'succeeded',targetId:'created-before-failure'});assert.equal((await runHostOperation(ledger,partial,other)).status,'succeeded');
 assert.equal((await runHostOperation(ledger,{operationId:'failed-jump',kind:'jump',targetId:'unavailable-chat'},{jump:async()=>{throw Error('TARGET_UNAVAILABLE');}})).status,'failed');
});
test('E 实际工作树与错误目录分支分别核验',async()=>{
 // 日期：2026-11-12。独立夹具验证分支门禁，不依赖执行者的main或detached构建状态。
 const repository=await mkdtemp(path.join(os.tmpdir(),'workbench-git-fixture-'));
 const git=args=>execFileSync('git',args,{cwd:repository,windowsHide:true});
 try {
  git(['init','-b','codex/fixture']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','fixture']);
  await writeFile(path.join(repository,'child.txt'),'fixture');
  const info=await inspectWorktree(repository,'codex/fixture');assert.equal(info.branch,'codex/fixture');assert.match(info.head,/^[a-f0-9]{40}$/);
  await assert.rejects(inspectWorktree(repository,'codex/wrong'),/BRANCH_MISMATCH/);
  const child=await mkdtemp(path.join(repository,'child-'));await assert.rejects(inspectWorktree(child),/ROOT_MISMATCH/);
 } finally {await rm(repository,{recursive:true,force:true});}
});
