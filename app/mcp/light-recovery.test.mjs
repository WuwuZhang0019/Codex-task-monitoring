// Date: 2026-11-16. Actual MCP requests over HTTP, with isolated crash/reply-loss fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLightBridge } from './light-bridge.mjs';
import { lightTools } from './light.mjs';
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const base = { schemaVersion: 'light-1.0', projectId: 'crash-project', planId: 'crash-plan', expectedRevision: 0,
  eventId: 'original-event', source: { path: 'fixture.md', version: '2026-11-16', sha256: 'a'.repeat(64), locator: 'fixture' },
  occurredAt: '2026-11-16T12:00:00+08:00', reason: 'crash recovery fixture' };
async function connect(t, config, options) {
  const server=createLightBridge(config,options),client=new Client({name:'codex-recovery-test',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
  t.after(async()=>{await client.close();await server.close();});return client;
}
async function fixture(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'bridge-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const token=randomBytes(32).toString('hex');let writes=0,queries=0,drop=true,committed=null;
  const owner=http.createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,`Bearer ${token}`);
    const json=value=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if(req.method==='GET')return json({tools:lightTools});
    let body='';for await(const chunk of req)body+=chunk;const call=JSON.parse(body);
    if(call.name==='workbench_query_event'){queries++;assert.equal(call.arguments.eventId,base.eventId);return json(result({status:'accepted',result:committed?{state:'committed',result:committed}:{state:'unknown'}}));}
    if(call.name==='workbench_reserve_execution'){
      writes++;committed={executionId:'original-execution',receipt:{eventId:base.eventId,status:'committed'}};
      if(drop)return req.socket.destroy();return json(result({status:'accepted',result:committed}));
    }
    return json(result({status:'accepted',result:{projects:[],executions:[]}}));
  });
  await new Promise(resolve=>owner.listen(0,'127.0.0.1',resolve));t.after(()=>{owner.closeAllConnections();owner.close();});
  const config={endpoint:`http://127.0.0.1:${owner.address().port}`,token};
  return {root,config,owner,counts:()=>({writes,queries}),drop:()=>{drop=false;},forget:()=>{committed=null;}};
}

test('a committed write with a lost response is recovered by its original event without replay',async t=>{
  const f=await fixture(t);let starts=0;
  const recovery={ensure:async check=>{starts++;return check();}};
  const client=await connect(t,f.config,{recovery,journalDirectory:path.join(f.root,'events')});
  const response=await client.callTool({name:'workbench_reserve_execution',arguments:base});
  assert.equal(response.structuredContent.status,'accepted');assert.equal(response.structuredContent.result.executionId,'original-execution');
  assert.deepEqual(f.counts(),{writes:1,queries:1});assert.ok(starts>=2);
  assert.deepEqual(await readdir(path.join(f.root,'events')),[]);
});

test('unresolved writes persist across bridge restart, reject changed payloads and query before same-key retry',async t=>{
  const f=await fixture(t),directory=path.join(f.root,'events');let broken=false;
  const recovery={ensure:async check=>{if(broken)throw Error('ISLAND_START_TIMEOUT');return check();}};
  // Lose the write reply and make the subsequent query unavailable.
  const first=await connect(t,f.config,{recovery,journalDirectory:directory});
  const originalEnsure=recovery.ensure;let attempts=0;
  recovery.ensure=async check=>{if(++attempts>1){broken=true;throw Error('ISLAND_START_TIMEOUT');}return originalEnsure(check);};
  const unknown=await first.callTool({name:'workbench_reserve_execution',arguments:base});assert.equal(unknown.structuredContent.error.code,'UNKNOWN_RESULT');
  const files=await readdir(directory);assert.equal(files.length,1);
  assert.equal((await readFile(path.join(directory,files[0]),'utf8')).includes(f.config.token),false);
  await first.close();broken=false;recovery.ensure=check=>check();
  const next=await connect(t,f.config,{recovery,journalDirectory:directory});
  const changed=await next.callTool({name:'workbench_reserve_execution',arguments:{...base,reason:'changed'}});
  assert.equal(changed.structuredContent.error.code,'IDEMPOTENCY_CONFLICT');
  const recovered=await next.callTool({name:'workbench_reserve_execution',arguments:base});
  assert.equal(recovered.structuredContent.result.executionId,'original-execution');assert.deepEqual(f.counts(),{writes:1,queries:1});
});

test('startup failure rejects an unsent write with a concrete recovery reason, and discovery never launches',async t=>{
  let attempts=0;
  const client=await connect(t,{endpoint:'http://127.0.0.1:1',token:'a'.repeat(64)},{allowOfflineDiscovery:true,
    recovery:{ensure:async()=>{attempts++;throw Error('ISLAND_LAUNCHER_MISSING');}}});
  assert.equal((await client.listTools()).tools.length,lightTools.length);assert.equal(attempts,0);
  const response=await client.callTool({name:'workbench_reserve_execution',arguments:base});
  assert.equal(response.structuredContent.status,'rejected');assert.equal(response.structuredContent.error.recovery,'ISLAND_LAUNCHER_MISSING');
  assert.equal(attempts,1);
});
