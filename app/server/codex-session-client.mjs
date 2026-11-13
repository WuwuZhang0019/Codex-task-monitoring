// 日期：2026-11-13。仅使用公开 app-server JSON-RPC，不读写 Codex 私有数据库。
import {spawn,execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import {existsSync} from 'node:fs';
import {readdir} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const clientError=(code,message=code)=>Object.assign(Error(message),{code});
const textInput=text=>[{type:'text',text,text_elements:[]}];

export function codexExecutable(){
  if(process.env.WORKBENCH_CODEX_BIN)return process.env.WORKBENCH_CODEX_BIN;
  if(process.platform==='win32'){
    const file=path.join(process.env.APPDATA??path.join(os.homedir(),'AppData/Roaming'),'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
    if(existsSync(file))return file;
    if(process.env.CODEX_APP_RUNTIME_CLI_PATH&&existsSync(process.env.CODEX_APP_RUNTIME_CLI_PATH))return process.env.CODEX_APP_RUNTIME_CLI_PATH;
    try{
      const location=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"(Get-AppxPackage -Name 'OpenAI.Codex' | Select-Object -First 1).InstallLocation"],{windowsHide:true,encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']}).trim();
      const bundled=path.join(location,'app/resources/codex.exe');if(location&&existsSync(bundled))return bundled;
    }catch{/* The PATH fallback also supports unpackaged Codex CLI installs. */}
  }
  return 'codex';
}
export function sessionEnvironment(environment=process.env){
  const env={...environment};
  // A standalone app-server must not inherit another chat's desktop launch identity.
  for(const key of ['CODEX_WINDOWS_REGISTERED_CORE','CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY','CODEX_APP_RUNTIME_CLI_PATH','CODEX_SESSION_ID','CODEX_THREAD_ID','CODEX_TOOL_CALL_ID','CODEX_APP_TOOLS_PIPE_PATH','CODEX_INTERNAL_ORIGINATOR_OVERRIDE'])delete env[key];
  return env;
}
export class CodexSessionClient{
  constructor({executable=codexExecutable(),spawnImpl=spawn,threadConfig}={}){this.executable=executable;this.spawnImpl=spawnImpl;this.threadConfig=threadConfig;this.pending=new Map();this.turns=new Map();this.finished=new Map();this.owned=new Set();this.sequence=0;this.transport='owned';}
  async connect(){
    if(this.child)return;
    this.child=this.spawnImpl(this.executable,['app-server','--stdio'],{windowsHide:true,env:sessionEnvironment(),stdio:['pipe','pipe','pipe']});
    this.child.stderr.on('data',()=>{});
    this.child.on('error',()=>this.fail('CODEX_UNAVAILABLE'));
    this.child.on('exit',()=>this.fail('CODEX_DISCONNECTED'));
    createInterface({input:this.child.stdout}).on('line',line=>{try{this.receive(JSON.parse(line));}catch{this.fail('CODEX_PROTOCOL_INVALID');}});
    await this.request('initialize',{clientInfo:{name:'task_island',title:'任务岛连续执行',version:'0.1.0'}});
    this.send({method:'initialized',params:{}});
  }
  send(value){this.child.stdin.write(JSON.stringify(value)+'\n');}
  request(method,params){return new Promise((resolve,reject)=>{const id=++this.sequence;const timer=setTimeout(()=>{this.pending.delete(id);reject(clientError('CODEX_REQUEST_UNKNOWN'));},30000);this.pending.set(id,{resolve,reject,timer});this.send({id,method,params});});}
  receive(message){
    const pending=this.pending.get(message.id);
    if(pending){clearTimeout(pending.timer);this.pending.delete(message.id);message.error?pending.reject(Object.assign(clientError('CODEX_REQUEST_REJECTED','CODEX_REQUEST_REJECTED: '+message.error.message),{rpcCode:message.error.code})):pending.resolve(message.result);return;}
    if(message.id!==undefined&&message.method){
      this.send({id:message.id,error:{code:-32000,message:'USER_INTERACTION_REQUIRED: 此请求需要人工处理，连续执行已暂停'}});
      this.interactionRequired=true;return;
    }
    if(message.method==='turn/completed'){
      const turn=message.params.turn;const key=message.params.threadId+'/'+turn.id;
      const waiter=this.turns.get(key);if(waiter){this.turns.delete(key);waiter.resolve(turn);}else this.finished.set(key,turn);
    }
  }
  fail(reason){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(clientError(reason));}this.pending.clear();for(const t of this.turns.values())t.reject(clientError(reason));this.turns.clear();}
  async create(cwd,title){await this.connect();const result=await this.request('thread/start',{cwd,...(this.threadConfig?{config:this.threadConfig}:{})});const thread=result.thread;if(!thread?.id||path.resolve(thread.cwd)!==path.resolve(cwd))throw Error('CODEX_THREAD_CONTEXT_MISMATCH');this.owned.add(thread.id);await this.request('thread/name/set',{threadId:thread.id,name:title});return thread;}
  async resume(threadId){await this.connect();const response=await this.request('thread/resume',{threadId,excludeTurns:true,...(this.threadConfig?{config:this.threadConfig}:{})});if(response.thread?.id!==threadId)throw clientError('CODEX_THREAD_CONTEXT_MISMATCH');this.owned.add(threadId);return response;}
  async readThread(threadId){
    await this.connect();
    const {thread}=await this.request('thread/read',{threadId,includeTurns:false});
    if(thread?.id!==threadId)throw clientError('CODEX_THREAD_CONTEXT_MISMATCH');
    const page=await this.request('thread/turns/list',{threadId,limit:1,sortDirection:'desc',itemsView:'notLoaded'});
    if(!Array.isArray(page.data))throw clientError('CODEX_PROTOCOL_INVALID');
    return {...thread,turns:[...page.data].reverse()};
  }
  async attach(threadId){
    if(!this.owned.has(threadId))throw clientError('CODEX_EXTERNAL_THREAD_REQUIRES_DESKTOP');
    return this.readThread(threadId);
  }
  async notify(threadId,text,{expectedTurnId,allowIdle=true}={}){
    const thread=await this.attach(threadId),active=thread.turns.findLast(t=>t.status==='inProgress');
    if(expectedTurnId!==undefined&&(thread.status?.type!=='active'||active?.id!==expectedTurnId))throw clientError('CODEX_ACTIVE_TURN_UNKNOWN');
    let method,params,delivery;
    if(thread.status?.type==='active'&&active?.id){method='turn/steer';params={threadId,expectedTurnId:active.id,input:textInput(text),clientUserMessageId:randomUUID()};delivery='steered';}
    else if(allowIdle&&thread.status?.type==='idle'&&!active){method='turn/start';params={threadId,input:textInput(text)};delivery='started';}
    else throw clientError('CODEX_ACTIVE_TURN_UNKNOWN');
    this.interactionRequired=false;
    try{
      const response=await this.request(method,params),turnId=response.turnId??response.turn?.id;
      if(!turnId||delivery==='steered'&&turnId!==active.id)throw clientError('CODEX_DELIVERY_UNKNOWN');
      return {turnId,delivery};
    }catch(error){if(error.code==='CODEX_REQUEST_REJECTED')throw clientError('CODEX_DELIVERY_REJECTED',error.message);throw clientError('CODEX_DELIVERY_UNKNOWN');}
  }
  async run(threadId,text,onStarted=async()=>{}){
    this.interactionRequired=false;
    const result=await this.request('turn/start',{threadId,input:textInput(text)});
    const turn=result.turn;if(!turn?.id)throw Error('CODEX_TURN_UNKNOWN');await onStarted(turn.id);
    const key=threadId+'/'+turn.id;
    if(this.finished.has(key)){const done=this.finished.get(key);this.finished.delete(key);return done;}
    return new Promise((resolve,reject)=>this.turns.set(key,{resolve,reject}));
  }
  close(){this.fail('CODEX_CLOSED');this.child?.stdin.end();this.child?.kill();this.child=null;}
}

// 日期：2026-11-13。桌面会话仅经宿主授予的官方 MCP 接入，不另起 app-server 接管原会话。
export async function desktopToolsServer(environment=process.env){
  const configured=environment.WORKBENCH_CODEX_APP_TOOLS_SERVER;
  if(configured&&existsSync(configured))return configured;
  const root=path.join(environment.CODEX_HOME??path.join(os.homedir(),'.codex'),'plugins/cache/openai-bundled/codex-app-tools');
  const versions=await readdir(root,{withFileTypes:true}).catch(()=>[]);
  for(const version of versions.filter(v=>v.isDirectory()).sort((a,b)=>b.name.localeCompare(a.name,'en',{numeric:true}))){const file=path.join(root,version.name,'server.mjs');if(existsSync(file))return file;}
  throw clientError('CODEX_DESKTOP_BRIDGE_UNAVAILABLE');
}
function unpackTool(result){
  if(result?.isError)throw clientError('CODEX_DESKTOP_REQUEST_REJECTED',result.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n')||'CODEX_DESKTOP_REQUEST_REJECTED');
  if(result?.structuredContent)return result.structuredContent;
  const text=result?.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n');
  try{return JSON.parse(text);}catch{throw clientError('CODEX_DESKTOP_PROTOCOL_INVALID');}
}
export class DesktopSessionClient{
  constructor({environment=process.env,clientFactory=()=>new Client({name:'task-island-desktop-control',version:'0.1.0'}),transportFactory=options=>new StdioClientTransport(options),serverResolver=desktopToolsServer,pollMs=1000,startTimeoutMs=30000,hostId='local'}={}){
    this.environment={...environment};this.clientFactory=clientFactory;this.transportFactory=transportFactory;this.serverResolver=serverResolver;this.pollMs=pollMs;this.startTimeoutMs=startTimeoutMs;this.hostId=hostId;this.transport='shared';this.closed=false;
  }
  async connect(){
    if(this.client)return;
    if(this.connecting)return this.connecting;
    this.connecting=this.open();
    try{await this.connecting;}finally{this.connecting=null;}
  }
  async open(){
    const env=this.environment;
    this.callerThreadId=env.CODEX_THREAD_ID??env.CODEX_SESSION_ID;
    if(!env.CODEX_APP_TOOLS_PIPE_PATH||!this.callerThreadId)throw clientError('CODEX_DESKTOP_BRIDGE_UNAVAILABLE');
    if(this.closed)throw clientError('CODEX_CLOSED');
    const server=await this.serverResolver(env),client=this.clientFactory();
    const forwarded={};
    for(const key of ['CODEX_APP_TOOLS_PIPE_PATH','CODEX_APP_TOOLS_CALLER_HOST_ID','CODEX_HOME','HOME','USERPROFILE','LOCALAPPDATA','PATH','SystemRoot','SYSTEMROOT','TEMP','TMP'])if(env[key]!==undefined)forwarded[key]=env[key];
    const transport=this.transportFactory({command:process.execPath,args:[server],env:forwarded,stderr:'pipe'});
    transport.stderr?.resume();
    try{
      await client.connect(transport);
      const catalog=await client.listTools();
      if(!['read_thread','send_message_to_thread'].every(name=>catalog.tools?.some(t=>t.name===name)))throw clientError('CODEX_DESKTOP_BRIDGE_UNAVAILABLE');
      if(this.closed)throw clientError('CODEX_CLOSED');
      this.client=client;
    }catch(error){await client.close().catch(()=>{});throw clientError(error.code==='CODEX_CLOSED'?'CODEX_CLOSED':'CODEX_DESKTOP_BRIDGE_UNAVAILABLE');}
  }
  async call(name,args){
    if(!['read_thread','send_message_to_thread'].includes(name))throw clientError('FORBIDDEN');
    await this.connect();
    if(this.closed)throw clientError('CODEX_CLOSED');
    return this.client.callTool({name,arguments:args,_meta:{'x-codex-turn-metadata':{thread_id:this.callerThreadId},'openai/toolCallId':'task-island-'+randomUUID()}},undefined,{timeout:30000});
  }
  async readThread(threadId){
    const payload=unpackTool(await this.call('read_thread',{threadId,hostId:this.hostId,turnLimit:1,includeOutputs:false})),thread=payload.thread;
    if(thread?.id!==threadId||thread.kind!=='codex'||thread.hostId!==this.hostId||!Array.isArray(payload.turns)||!['idle','active','notLoaded','systemError'].includes(thread.status?.type))throw clientError('CODEX_THREAD_CONTEXT_MISMATCH');
    this.interactionRequired=thread.status.activeFlags?.some(flag=>['waitingOnApproval','waitingOnUserInput'].includes(flag))??false;
    return {...thread,turns:payload.page?.order==='newest_first'?[...payload.turns].reverse():payload.turns};
  }
  async attach(threadId){return this.readThread(threadId);}
  async resume(threadId){return {thread:await this.attach(threadId)};}
  async notify(threadId,text){
    const before=await this.attach(threadId);
    if(!['idle','active','notLoaded'].includes(before.status.type))throw clientError('CODEX_ACTIVE_TURN_UNKNOWN');
    // The desktop owns routing of active follow-ups. Report only confirmed delivery, never assume steering.
    let result;
    try{result=await this.call('send_message_to_thread',{threadId,hostId:this.hostId,prompt:text});}
    catch{throw clientError('CODEX_DELIVERY_UNKNOWN');}
    if(result?.isError)throw clientError('CODEX_DELIVERY_REJECTED',result.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n')||'CODEX_DELIVERY_REJECTED');
    let payload;
    try{payload=unpackTool(result);}catch{throw clientError('CODEX_DELIVERY_UNKNOWN');}
    const returnedId=payload.threadId??payload.thread?.id;
    if(returnedId&&returnedId!==threadId)throw clientError('CODEX_DELIVERY_UNKNOWN');
    let turnId=payload.turnId??payload.turn?.id;
    const active=before.turns.findLast(turn=>turn.status==='inProgress');
    if(before.status.type==='active'){
      if(!turnId&&!active?.id)throw clientError('CODEX_DELIVERY_UNKNOWN');
      return {turnId:turnId??active.id,delivery:'sent'};
    }
    if(turnId)return {turnId,delivery:'sent'};
    const prior=before.turns.at(-1),acceptedAt=Date.now();
    // Idle desktop delivery may be asynchronous. An old completed turn is never a delivery receipt.
    while(!this.closed){
      let thread;
      try{thread=await this.readThread(threadId);}catch{throw clientError('CODEX_DELIVERY_UNKNOWN');}
      const latest=thread.turns.at(-1);
      if(latest?.id&&latest.id!==prior?.id)return {turnId:latest.id,delivery:'sent'};
      if(Date.now()-acceptedAt>=this.startTimeoutMs)throw clientError('CODEX_DELIVERY_UNKNOWN');
      await new Promise(resolve=>setTimeout(resolve,this.pollMs));
    }
    throw clientError('CODEX_DELIVERY_UNKNOWN');
  }
  async run(threadId,text,onStarted=async()=>{}){
    const before=await this.readThread(threadId),prior=before.turns.at(-1);
    if(before.status.type==='active')throw clientError('CODEX_THREAD_BUSY');
    const sent=await this.notify(threadId,text),startedAt=Date.now();
    let turnId=sent.turnId;
    if(turnId)await onStarted(turnId);
    while(!this.closed){
      const thread=await this.readThread(threadId),latest=thread.turns.at(-1);
      if(this.interactionRequired)throw clientError('CODEX_INTERACTION_REQUIRED','需要人工确认，请处理该阶段会话后继续');
      if(!turnId&&latest?.id&&latest.id!==prior?.id){turnId=latest.id;await onStarted(turnId);}
      if(turnId&&latest?.id===turnId&&latest.status!=='inProgress')return latest;
      if(!turnId&&Date.now()-startedAt>=this.startTimeoutMs)throw clientError('CODEX_DELIVERY_UNKNOWN');
      await new Promise(resolve=>setTimeout(resolve,this.pollMs));
    }
    throw clientError('CODEX_CLOSED');
  }
  close(){this.closed=true;void this.client?.close().catch(()=>{});this.client=null;}
}
export function createSessionClient(options={}){return options.transport==='shared'?new DesktopSessionClient(options):new CodexSessionClient(options);}
