// Date: 2026-11-12. Local installation assistant; it never reads an owner/management credential.
import path from 'node:path';
import os from 'node:os';
import { readFile, realpath, stat, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { validAppId, agentApps } from '../server/light-apps.mjs';
import { discoverOwner } from '../desktop/client.mjs';
import { preparePrivateDirectory } from '../desktop/private-runtime.mjs';
import { loadLightConfig } from './light-bridge.mjs';

const defaultBase = () => path.join(os.homedir(), '.codex/task-workbench-light');
async function limitedRead(file) {
  if ((await stat(file)).size > 32768) throw Error('INVALID_LOCAL_FILE');
  const bytes = await readFile(file);
  if (bytes.length > 32768) throw Error('INVALID_LOCAL_FILE');
  return bytes;
}
export async function readOnboardingRequest(file, { baseDir = defaultBase(), now = Date.now } = {}) {
  const directory = path.join(baseDir, 'onboarding');
  if (!path.isAbsolute(file) || path.dirname(path.resolve(file)) !== path.resolve(directory)
    || !/^[a-f0-9-]{36}\.json$/.test(path.basename(file))) throw Error('INVALID_REQUEST_PATH');
  const actual = await realpath(file), expected = path.join(await realpath(directory), path.basename(file));
  if (actual.toLowerCase() !== expected.toLowerCase()) throw Error('INVALID_REQUEST_PATH');
  const value = JSON.parse(await limitedRead(file));
  if (!value || !validAppId(value.appId) || !/^[a-f0-9]{64}$/.test(value.ticket)
    || typeof value.dataDir !== 'string' || !path.isAbsolute(value.dataDir)
    || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= now()
    || Object.keys(value).some(key => !['date','appId','ticket','expiresAt','dataDir'].includes(key))) throw Error('INVALID_OR_EXPIRED_REQUEST');
  return { ...value, baseDir };
}
export function describeRequest(request) {
  const runtime = path.join(request.baseDir, 'runtime/light.mjs');
  return { appId: request.appId, application: agentApps.find(app => app.id === request.appId).name,
    expiresAt: request.expiresAt, skillPath: path.join(request.baseDir, 'runtime/skills/workbench-handoff/SKILL.md'),
    mcpConfig: { mcpServers: { 'task-workbench': { type: 'stdio', command: process.execPath, args: [runtime],
      env: { WORKBENCH_LIGHT_APP: request.appId } } } } };
}
async function atomicWrite(file, bytes) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function redeemTicket(endpoint, body) {
  // A fresh core HTTP agent avoids inherited environment proxies and never follows redirects.
  return new Promise((resolve,reject) => {
    const call=http.request(new URL('/api/light-onboarding',endpoint),{method:'POST',agent:new http.Agent(),
      headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(10000)},response=>{
      if(response.statusCode!==200){response.resume();reject(Error(response.statusCode===403?'ONBOARDING_REQUEST_EXPIRED_OR_REVOKED':'ONBOARDING_RESULT_UNKNOWN'));return;}
      const chunks=[];let length=0;
      response.on('data',chunk=>{length+=chunk.length;if(length>65536)response.destroy(Error('ONBOARDING_RESULT_UNKNOWN'));else chunks.push(chunk);});
      response.on('error',reject);
      response.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(Error('ONBOARDING_RESULT_UNKNOWN'));}});
    });
    call.on('error',()=>reject(Error('ONBOARDING_RESULT_UNKNOWN')));
    call.end(JSON.stringify(body));
  });
}
export async function completeRequest(request) {
  const directory = request.appId === 'codex' ? request.baseDir : path.join(request.baseDir, 'connections', request.appId);
  await preparePrivateDirectory(directory);
  const files = ['config.json','connection-result.json'];
  const previous = await Promise.all(files.map(async file => {
    try { return await limitedRead(path.join(directory, file)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }));
  let currentToken;
  if (previous[0]) {
    const existing = await loadLightConfig(path.join(directory, 'config.json'));
    if (existing.dataDir && path.resolve(existing.dataDir).toLowerCase() !== path.resolve(request.dataDir).toLowerCase()) throw Error('CONNECTION_DATA_MISMATCH');
    currentToken = existing.token;
    for (let index = 0; index < files.length; index++) if (previous[index])
      await writeFile(path.join(directory, `onboarding-backup-${randomUUID()}-${files[index]}`), previous[index], { flag:'wx',mode:0o600 });
  }
  const owner = await discoverOwner(request.dataDir);
  const result = await redeemTicket(owner.endpoint,{ticket:request.ticket,appId:request.appId,...(currentToken?{currentToken}:{})});
  const current = await discoverOwner(request.dataDir);
  if (current.endpoint !== owner.endpoint || current.ownerGeneration !== owner.ownerGeneration) throw Error('ONBOARDING_RESULT_UNKNOWN');
  if (result.appId !== request.appId || typeof result.principal !== 'string' || !/^[a-f0-9]{64}$/.test(result.token)) throw Error('ONBOARDING_RESULT_UNKNOWN');
  const values = [{dataDir:request.dataDir,token:result.token},
    {date:request.date,appId:request.appId,principal:result.principal,automatic:true,configPath:path.join(directory,'config.json')}];
  try {
    for (let index = 0; index < files.length; index++) await atomicWrite(path.join(directory,files[index]),JSON.stringify(values[index],null,2));
  } catch {
    let restored = true;
    for (let index = 0; index < files.length; index++) {
      try { if (previous[index]) await atomicWrite(path.join(directory,files[index]),previous[index]);
        else await unlink(path.join(directory,files[index])).catch(error => { if(error.code!=='ENOENT')throw error; }); }
      catch { restored = false; }
    }
    throw Error(restored ? 'CONFIG_SAVE_FAILED_RETRY_SAME_REQUEST' : 'CONFIG_RESTORE_FAILED_CHECK_BACKUP');
  }
  return { appId:request.appId,enabled:true,requiresHostVerification:true,
    message:'本机连接已自动开启。请在对应应用重载 MCP 并确认工具发现；真实通信后任务岛会显示已连接。' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2), position=args.indexOf('--request');
    if(position<0 || args.length!==3 || !args.includes('--describe') && !args.includes('--complete')) throw Error('USAGE_REQUEST_DESCRIBE_OR_COMPLETE');
    const request=await readOnboardingRequest(args[position+1]);
    console.log(JSON.stringify(args.includes('--complete') ? await completeRequest(request) : describeRequest(request),null,2));
  } catch { console.error('任务岛接入未完成。请核对请求有效期、应用配置和本机服务；可重新复制指令，勿在聊天中输出凭据。');process.exitCode=1; }
}
