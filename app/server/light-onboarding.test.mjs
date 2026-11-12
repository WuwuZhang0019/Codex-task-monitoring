// Date: 2026-11-12. Agent onboarding is app-scoped, replay-safe, local-only, and does not fake client presence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createPersistence } from './persistence.mjs';
import { createLightAccess } from './light-access.mjs';
import { createLightOnboarding } from './light-onboarding.mjs';
import { createServer, HttpError } from './index.mjs';
const { readOnboardingRequest, describeRequest, completeRequest } = await import(process.env.ONBOARDING_HELPER_MODULE
  ? pathToFileURL(process.env.ONBOARDING_HELPER_MODULE).href : new URL('../mcp/onboard.mjs',import.meta.url).href);

test('copying instructions grants only a short-lived ticket; redemption is app-scoped, repeatable and revocable', async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'onboarding-scope-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const persistence=await createPersistence(root), access=createLightAccess(persistence);
  let time=Date.now(); const onboarding=createLightOnboarding(persistence,{now:()=>time});
  await assert.rejects(async()=>onboarding.prepare({appId:'claude-code',acknowledged:false}),/INVALID_INPUT/);
  const pending=await onboarding.prepare({appId:'claude-code',acknowledged:true});
  assert.equal(access.panelConnections().some(app=>app.enabled),false,'copy is not connection completion');
  await assert.rejects(async()=>onboarding.redeem({ticket:pending.ticket,appId:'workbuddy'}),/FORBIDDEN/);
  const result=await onboarding.redeem({ticket:pending.ticket,appId:'claude-code'});
  assert.deepEqual(await onboarding.redeem({ticket:pending.ticket,appId:'claude-code'}),result,'lost responses use the same request and identity');
  assert.equal(Object.values(persistence.read('grants')).filter(grant=>grant.kind==='lightAccess').length,1);
  assert.equal(access.connectionStatus({principal:result.principal,acknowledged:true}).connected,false,'enablement is not a real host heartbeat');
  await access.revoke({principal:result.principal,acknowledged:true});
  await assert.rejects(async()=>onboarding.redeem({ticket:pending.ticket,appId:'claude-code'}),/FORBIDDEN/,'replaying a ticket cannot undo disconnect');
  const expired=await onboarding.prepare({appId:'dsh',acknowledged:true});time+=30*60*1000+1;
  await assert.rejects(async()=>onboarding.redeem({ticket:expired.ticket,appId:'dsh'}),/FORBIDDEN/);
});

test('onboarding reuses an existing automatic connection rather than breaking active bindings',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'onboarding-reuse-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const persistence=await createPersistence(root),access=createLightAccess(persistence),onboarding=createLightOnboarding(persistence);
 const existing=await access.connect({appId:'codex',acknowledged:true});
 const request=await onboarding.prepare({appId:'codex',acknowledged:true});
 const body={ticket:request.ticket,appId:'codex',currentToken:existing.token};
 const result=await onboarding.redeem(body);
 assert.equal(result.principal,existing.principal);assert.equal(result.token,existing.token);
 assert.deepEqual(await onboarding.redeem(body),result);
 const stillPending=await onboarding.prepare({appId:'codex',acknowledged:true});
 await access.revoke({principal:existing.principal,acknowledged:true});
 await assert.rejects(async()=>onboarding.redeem(body),/FORBIDDEN/);
 await assert.rejects(async()=>onboarding.redeem({ticket:stillPending.ticket,appId:'codex'}),/FORBIDDEN/,'disconnect cancels previously copied requests');
});

test('local helper completes setup without owner credentials or manual connection clicks and preserves other applications',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'onboarding-helper-')),base=path.join(root,'user'),data=path.join(root,'data');
 const manager='a'.repeat(64);
 const server=await createServer({dataDir:data,env:{},lightAccessEnabled:true,authorize(req,route){
   if(['/api/light-onboarding','/api/light-mcp'].includes(route))return;
   if(req.headers.authorization!=='Bearer '+manager)throw new HttpError(403,'FORBIDDEN');
 }});
 server.listen(0,'127.0.0.1');await once(server,'listening');const endpoint=`http://127.0.0.1:${server.address().port}`;
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
 await writeFile(path.join(data,'owner.json'),JSON.stringify({version:1,ownerGeneration:'onboard-test',endpoint}));
 const post=async(route,body,headers={})=>fetch(endpoint+route,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body),redirect:'error'});
 assert.equal((await post('/api/light-access/prepare-onboarding',{appId:'claude-code',acknowledged:true})).status,403);
 assert.equal((await post('/api/light-onboarding',{ticket:'b'.repeat(64),appId:'claude-code'})).status,403);
 const issued=await(await post('/api/light-access/prepare-onboarding',{appId:'claude-code',acknowledged:true},{Authorization:'Bearer '+manager})).json();
 await mkdir(path.join(base,'onboarding'),{recursive:true});await mkdir(path.join(base,'connections/workbuddy'),{recursive:true});
 const otherFile=path.join(base,'connections/workbuddy/config.json');await writeFile(otherFile,'unchanged-other-app');
 const file=path.join(base,'onboarding',issued.requestId+'.json');
 await writeFile(file,JSON.stringify({date:'2026-11-12',appId:issued.appId,ticket:issued.ticket,expiresAt:issued.expiresAt,dataDir:data}));
 const request=await readOnboardingRequest(file,{baseDir:base});
 assert.ok(!JSON.stringify(describeRequest(request)).includes(issued.ticket));
 assert.equal(describeRequest(request).mcpConfig.mcpServers['task-workbench'].env.WORKBENCH_LIGHT_APP,'claude-code');
 const completed=await completeRequest(request);
 assert.equal(completed.enabled,true);assert.equal(completed.requiresHostVerification,true);
 assert.ok(!JSON.stringify(completed).includes(issued.ticket));assert.ok(!JSON.stringify(completed).includes('token'));
 const configFile=path.join(base,'connections/claude-code/config.json'),config=JSON.parse(await readFile(configFile,'utf8'));
 const metadataFile=path.join(base,'connections/claude-code/connection-result.json'),metadata=JSON.parse(await readFile(metadataFile,'utf8'));
 assert.ok(config.token);assert.ok(!metadata.token);assert.equal(metadata.appId,'claude-code');
 await completeRequest(request);assert.equal(JSON.parse(await readFile(configFile,'utf8')).token,config.token);
 assert.equal(await readFile(otherFile,'utf8'),'unchanged-other-app');
 const status=await(await post('/api/light-access/connection-status',{principal:metadata.principal,acknowledged:true},{Authorization:'Bearer '+manager})).json();
 assert.equal(status.enabled,true);assert.equal(status.connected,false);
 assert.equal((await post('/api/light-onboarding',{ticket:issued.ticket,appId:'claude-code'},{Origin:'http://localhost'})).status,403);
 await assert.rejects(readOnboardingRequest(path.join(root,'outside.json'),{baseDir:base}),/INVALID_REQUEST_PATH/);
});
