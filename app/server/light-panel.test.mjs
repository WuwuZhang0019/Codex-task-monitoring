// 日期 2026-11-11。持久面板与业务读取同源、偏好不改业务版本、私有边界。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer,HttpError} from './index.mjs';
import {prepareLightPlan} from './light-import.mjs';
import { bindingApplications } from './light-panel.mjs';
import { digest } from './receipts.mjs';

test('application ownership reconciles historical confirmation grants without guessing unknown tasks', () => {
 const grants = { legacy: { kind:'lightAccess' }, claude: { kind:'lightAccess',appId:'claude-code' },
   confirmation: { kind:'lightBindingConfirmation',principal:'legacy' } };
 const bindings = [{key:'old',confirmationRef:`grant:${digest('confirmation')}`},
   {key:'automatic',confirmationRef:'automatic:claude'}, {key:'proposed',confirmationRef:null}, {key:'unknown',confirmationRef:'other'}];
 assert.deepEqual(bindingApplications(bindings,grants,{proposed:'claude'}),{old:'codex',automatic:'claude-code',proposed:'claude-code'});
});

test('private panel shares committed snapshot, verifies source, persists preferences without business revision',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'light-f-panel-'));
 const text='# 面板同源测试\n日期：2026-11-11\n## 实施路线与出口\n| 阶段 | 前置 | 范围 | 出口 |\n| A 数据 | 用户已确认 | 数据 | 持久可回读 |\n';
 const file=path.join(root,'source.md');await writeFile(file,text);
 let server;
 async function open(){server=await createServer({dataDir:path.join(root,'data'),env:{},lightAccessEnabled:true,lightAuthorize:()=>true,authorize(req){if(req.headers.authorization!=='Bearer owner')throw new HttpError(403,'FORBIDDEN');}});await new Promise(r=>server.listen(0,'127.0.0.1',r));}
 async function close(){await new Promise(r=>server.close(r));}
 try{
  await open();
  const snapshot=prepareLightPlan({text,sourcePath:file,version:'F-test',projectKey:'F/project',planKey:'F/plan',name:'F面板',date:'2026-11-11',context:{sessionGroup:'F',threadId:'F-test',hostId:'local',folderId:null,worktreeOrdinal:1,worktreePath:root,branch:'main',head:null,trust:'declared'}});
  const registered=await server.workbench.light.register('test',{eventId:'register',expectedRevision:0,snapshot});
  const base=()=>`http://127.0.0.1:${server.address().port}/api/light-panel`;
  const get=async()=>{const r=await fetch(base(),{headers:{Authorization:'Bearer owner'}});assert.equal(r.status,200);return r.json();};
  const read=await get();assert.deepEqual(read.snapshot,server.workbench.light.read('test',registered.projectId));assert.equal(read.sources['F/plan'],text);assert.equal(read.capabilities.threadJump,false);
  const revision=read.snapshot.revision;
  assert.equal((await fetch(base())).status,403);
  assert.equal((await fetch(base(),{headers:{Authorization:'Bearer plugin-token'}})).status,403);
  const prefs={collapsed:['F/project'],selected:read.snapshot.steps[0].key,focus:[],scroll:{'all/F/project':120},y:{all:45}};
  const put=v=>fetch(base()+'/preferences',{method:'PUT',headers:{Authorization:'Bearer owner','Content-Type':'application/json'},body:JSON.stringify(v)});
  assert.equal((await put({...prefs,selected:{}})).status,400);
  assert.equal((await put({...prefs,y:{all:-1}})).status,400);
  assert.equal((await put(prefs)).status,200);
  assert.equal((await get()).snapshot.revision,revision);
  await close();await writeFile(file,'已改变原文');await open();
  const reopened=await get();assert.deepEqual(reopened.preferences,prefs);assert.equal(reopened.snapshot.revision,revision);assert.equal(reopened.sources['F/plan'],null);
 }finally{if(server?.listening)await close();await rm(root,{recursive:true,force:true});}
});
