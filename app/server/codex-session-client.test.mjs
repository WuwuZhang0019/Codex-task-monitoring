// 日期：2026-11-13。新会话隔离桌面启动身份，保留用户正常配置环境。
import test from 'node:test';
import assert from 'node:assert/strict';
import {CodexSessionClient,DesktopSessionClient,createSessionClient,sessionEnvironment} from './codex-session-client.mjs';
test('standalone stages never inherit a parent chat identity or registered desktop launcher',()=>{
 const input={PATH:'tools',APPDATA:'data',CODEX_HOME:'config',CODEX_WINDOWS_REGISTERED_CORE:'1',CODEX_THREAD_ID:'parent',CODEX_SESSION_ID:'parent',CODEX_APP_TOOLS_PIPE_PATH:'parent-pipe'};
 assert.deepEqual(sessionEnvironment(input),{PATH:'tools',APPDATA:'data',CODEX_HOME:'config'});
 assert.equal(input.CODEX_THREAD_ID,'parent');
});

test('owned steering targets the live turn and never starts a parallel turn',async()=>{
 const client=new CodexSessionClient();client.owned.add('own');const calls=[];
 client.connect=async()=>{};
 client.request=async(method,params)=>{calls.push({method,params});if(method==='thread/read')return{thread:{id:'own',status:{type:'active'}}};if(method==='thread/turns/list')return{data:[{id:'live',status:'inProgress'}]};if(method==='turn/steer')return{turnId:'live'};throw Error(method);};
 assert.deepEqual(await client.notify('own','继续本阶段'),{turnId:'live',delivery:'steered'});
 assert.deepEqual(calls.map(c=>c.method),['thread/read','thread/turns/list','turn/steer']);
 assert.equal(calls[2].params.expectedTurnId,'live');assert.equal(calls[2].params.input[0].text,'继续本阶段');
});

test('owned stage notifications cannot start a new turn after their expected active turn has ended or changed',async()=>{
 for(const thread of [
  {id:'own',status:{type:'idle'},turns:[{id:'expected',status:'completed'}]},
  {id:'own',status:{type:'active'},turns:[{id:'replacement',status:'inProgress'}]},
 ]){
  const client=new CodexSessionClient();const calls=[];
  client.attach=async()=>thread;client.request=async(method,params)=>{calls.push({method,params});throw Error('must not send');};
  await assert.rejects(client.notify('own','只继续原阶段',{expectedTurnId:'expected',allowIdle:false}),{code:'CODEX_ACTIVE_TURN_UNKNOWN'});
  assert.deepEqual(calls,[]);
 }
 const client=new CodexSessionClient();client.attach=async()=>({id:'own',status:{type:'idle'},turns:[]});
 client.request=async()=>{throw Error('must not start');};
 await assert.rejects(client.notify('own','不可空闲启动',{allowIdle:false}),{code:'CODEX_ACTIVE_TURN_UNKNOWN'});
});

test('owned idle delivery starts one turn and refuses unowned external chats',async()=>{
 const client=new CodexSessionClient();client.owned.add('own');const calls=[];
 client.connect=async()=>{};
 client.request=async(method,params)=>{calls.push({method,params});if(method==='thread/read')return{thread:{id:'own',status:{type:'idle'}}};if(method==='thread/turns/list')return{data:[{id:'old',status:'completed'}]};if(method==='turn/start')return{turn:{id:'new'}};throw Error(method);};
 assert.deepEqual(await client.notify('own','下一阶段'),{turnId:'new',delivery:'started'});
 await assert.rejects(client.notify('external','不可另起进程接手'),{code:'CODEX_EXTERNAL_THREAD_REQUIRES_DESKTOP'});
 assert.equal(calls.filter(c=>c.method==='turn/start').length,1);
 assert.equal(calls.some(c=>c.method==='thread/resume'),false);
});

test('owned resume reapplies its isolated thread configuration instead of falling back to default MCP endpoints',async()=>{
 const config={'mcp_servers.task_workbench.url':'http://127.0.0.1:12345/isolated-test'};
 const client=new CodexSessionClient({threadConfig:config});const calls=[];
 client.connect=async()=>{};
 client.request=async(method,params)=>{calls.push({method,params});return{thread:{id:'restored',cwd:'fixture'}};};
 const result=await client.resume('restored');
 assert.deepEqual(calls,[{method:'thread/resume',params:{threadId:'restored',excludeTurns:true,config}}]);
 assert.equal(result.thread.id,'restored');assert.equal(client.owned.has('restored'),true);
});

test('stale steer rejection is not retried as a new turn and lost responses remain unknown',async()=>{
 for(const code of ['CODEX_REQUEST_REJECTED','CODEX_DISCONNECTED']){
  const client=new CodexSessionClient();client.owned.add('own');let sends=0;
  client.attach=async()=>({id:'own',status:{type:'active'},turns:[{id:'active',status:'inProgress'}]});
  client.request=async()=>{sends++;throw Object.assign(Error('rejected'),{code});};
  await assert.rejects(client.notify('own','继续'),{code:code==='CODEX_REQUEST_REJECTED'?'CODEX_DELIVERY_REJECTED':'CODEX_DELIVERY_UNKNOWN'});
  assert.equal(sends,1);
 }
});

function desktopFixture({results=[],sendError=false,sendRejected=false}={}){
 const calls=[],states=[...results];let closed=false;let catalog=0;let options;let sent=false;
 const result=payload=>({content:[{type:'text',text:JSON.stringify(payload)}],isError:false});
 const client={
  async connect(){},
  async listTools(){catalog++;return{tools:[{name:'read_thread'},{name:'send_message_to_thread'}]};},
  async callTool(input){calls.push(input);if(input.name==='send_message_to_thread'){sent=true;if(sendError)throw Error('lost response');if(sendRejected)return{isError:true,content:[{type:'text',text:'explicit rejection'}]};return result({threadId:'target'});}return result(states.shift()??{thread:{id:'target',kind:'codex',hostId:'local',cwd:'fixture',status:{type:'idle'}},page:{order:'newest_first'},turns:sent?[{id:'delivered',status:'completed'}]:[]});},
  async close(){closed=true;},
 };
 const desktop=new DesktopSessionClient({environment:{CODEX_APP_TOOLS_PIPE_PATH:'granted-pipe',CODEX_THREAD_ID:'caller',SECRET:'do-not-forward'},clientFactory:()=>client,transportFactory:value=>{options=value;return{};},serverResolver:async()=>'/official-plugin/server.mjs',pollMs:0,startTimeoutMs:100});
 return{desktop,calls,get options(){return options;},get closed(){return closed;},get catalogs(){return catalog;}};
}
const desktopThread=(status='idle',turns=[])=>({thread:{id:'target',kind:'codex',hostId:'local',cwd:'fixture',status:{type:status}},page:{order:'newest_first'},turns});

test('desktop bridge uses only the granted host and the exact target without model overrides',async()=>{
 const f=desktopFixture({results:[desktopThread('active',[{id:'active',status:'inProgress'}])]});
 assert.deepEqual(await f.desktop.notify('target','按既定方案持续执行'),{turnId:'active',delivery:'sent'});
 assert.equal(f.catalogs,1);assert.deepEqual(f.calls.map(c=>c.name),['read_thread','send_message_to_thread']);
 const input=f.calls[1];assert.deepEqual(input.arguments,{threadId:'target',hostId:'local',prompt:'按既定方案持续执行'});
 assert.equal(input._meta['x-codex-turn-metadata'].thread_id,'caller');
 assert.equal(f.options.env.CODEX_APP_TOOLS_PIPE_PATH,'granted-pipe');assert.equal(f.options.env.SECRET,undefined);
 assert.equal(f.options.args[0],'/official-plugin/server.mjs');f.desktop.close();assert.equal(f.closed,true);
});

test('desktop bridge refuses missing grants and mismatched target identities before sending',async()=>{
 const client=new DesktopSessionClient({environment:{}});
 await assert.rejects(client.notify('target','继续'),{code:'CODEX_DESKTOP_BRIDGE_UNAVAILABLE'});
 const f=desktopFixture({results:[{...desktopThread(),thread:{...desktopThread().thread,id:'other'}}]});
 await assert.rejects(f.desktop.notify('target','继续'),{code:'CODEX_THREAD_CONTEXT_MISMATCH'});
 assert.equal(f.calls.some(c=>c.name==='send_message_to_thread'),false);f.desktop.close();
});

test('desktop delivery loss is unknown and does not resend',async()=>{
 const f=desktopFixture({sendError:true});
 await assert.rejects(f.desktop.notify('target','继续'),{code:'CODEX_DELIVERY_UNKNOWN'});
 assert.equal(f.calls.filter(c=>c.name==='send_message_to_thread').length,1);f.desktop.close();
});

test('desktop explicit rejection stays rejected and does not resend',async()=>{
 const f=desktopFixture({sendRejected:true});
 await assert.rejects(f.desktop.notify('target','继续'),{code:'CODEX_DELIVERY_REJECTED'});
 assert.equal(f.calls.filter(c=>c.name==='send_message_to_thread').length,1);f.desktop.close();
});

test('desktop idle delivery waits through old completed snapshots until a new turn appears',async()=>{
 const old={id:'old',status:'completed'},next={id:'new',status:'inProgress'};
 const f=desktopFixture({results:[desktopThread('idle',[old]),desktopThread('idle',[old]),desktopThread('idle',[old]),desktopThread('active',[next])]});
 assert.deepEqual(await f.desktop.notify('target','继续'),{turnId:'new',delivery:'sent'});
 assert.equal(f.calls.filter(c=>c.name==='send_message_to_thread').length,1);assert.equal(f.calls.filter(c=>c.name==='read_thread').length,4);f.desktop.close();
});

test('desktop run waits for a newly observed turn and its completion after delivery',async()=>{
 const old={id:'old',status:'completed'},active={id:'new',status:'inProgress'},done={id:'new',status:'completed'};
 const f=desktopFixture({results:[desktopThread('idle',[old]),desktopThread('idle',[old]),desktopThread('idle',[old]),desktopThread('active',[active]),desktopThread('idle',[done])]});
 const seen=[];const turn=await f.desktop.run('target','下阶段',async id=>seen.push(id));
 assert.equal(turn.status,'completed');assert.deepEqual(seen,['new']);
 assert.equal(f.calls.filter(c=>c.name==='send_message_to_thread').length,1);assert.equal(f.calls.filter(c=>c.name==='read_thread').length,5);f.desktop.close();
});

test('desktop run refuses busy threads and does not mistake old completed turns for a new execution',async()=>{
 const busy=desktopFixture({results:[desktopThread('active',[{id:'active',status:'inProgress'}])]});
 await assert.rejects(busy.desktop.run('target','下阶段'),{code:'CODEX_THREAD_BUSY'});assert.equal(busy.calls.some(c=>c.name==='send_message_to_thread'),false);busy.desktop.close();
 const old={id:'old',status:'completed'};const f=desktopFixture({results:[desktopThread('idle',[old]),desktopThread('idle',[old]),desktopThread('idle',[old])]});f.desktop.startTimeoutMs=0;
 await assert.rejects(f.desktop.run('target','下阶段'),{code:'CODEX_DELIVERY_UNKNOWN'});assert.equal(f.calls.filter(c=>c.name==='send_message_to_thread').length,1);f.desktop.close();
});

test('desktop run stops for human interaction instead of waiting indefinitely or approving it',async()=>{
 const waiting=desktopThread('active',[{id:'new',status:'inProgress'}]);waiting.thread.status.activeFlags=['waitingOnApproval'];
 const old={id:'old',status:'completed'};
 const f=desktopFixture({results:[desktopThread('idle',[old]),desktopThread('idle',[old]),waiting,waiting]});
 await assert.rejects(f.desktop.run('target','继续'),{code:'CODEX_INTERACTION_REQUIRED'});
 assert.equal(f.desktop.interactionRequired,true);assert.equal(f.calls.filter(c=>c.name==='send_message_to_thread').length,1);f.desktop.close();
});

test('session factory keeps stage execution owned and routes external notifications through the desktop',()=>{
 assert.ok(createSessionClient() instanceof CodexSessionClient);
 assert.ok(createSessionClient({transport:'shared'}) instanceof DesktopSessionClient);
});
