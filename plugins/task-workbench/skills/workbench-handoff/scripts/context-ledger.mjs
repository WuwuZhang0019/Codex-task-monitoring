// 日期：2026-11-11。宿主固定身份与操作日志；名称只用于显示。
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realpath} from 'node:fs/promises';
import path from 'node:path';
const git=promisify(execFile);
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const requireValue=(v,e)=>{if(!v)throw new Error(e);};
export function folderName({planName,branch,ordinal=1,multipleWorktrees=false}){
 requireValue(planName&&(!multipleWorktrees||branch&&Number.isSafeInteger(ordinal)&&ordinal>0),'NAME_CONTEXT_REQUIRED');
 const emoji=String(ordinal).split('').map(n=>n+'\uFE0F\u20E3').join('');return multipleWorktrees?`${emoji} ${planName} · ${branch}`:planName;
}
export function executionTitle(instruction){const line=instruction.split(/\r?\n/).find(s=>s.trim());const title=line?.trim().match(/^开始执行\s*(.+)$/)?.[1]?.replace(/[。.]$/,'').trim();requireValue(title,'EXECUTION_TITLE_REQUIRED');return title;}
export async function inspectWorktree(directory,expectedBranch){
 requireValue(path.isAbsolute(directory),'ABSOLUTE_WORKTREE_REQUIRED');const actual=await realpath(directory);const opts={cwd:actual,windowsHide:true,timeout:5000};
 const run=async args=>(await git('git',args,opts)).stdout.trim();const top=await realpath(await run(['rev-parse','--show-toplevel']));
 requireValue((process.platform==='win32'?top.toLowerCase():top)===(process.platform==='win32'?actual.toLowerCase():actual),'WORKTREE_ROOT_MISMATCH');
 const branch=await run(['symbolic-ref','--quiet','--short','HEAD']);requireValue(!expectedBranch||branch===expectedBranch,'WORKTREE_BRANCH_MISMATCH');
 const common=await realpath(path.resolve(actual,await run(['rev-parse','--git-common-dir'])));
 return {worktreePath:actual,repositoryRoot:path.dirname(common),gitCommonDir:common,branch,head:await run(['rev-parse','HEAD'])};
}
export function recordMapping(ledger,mapping){
 requireValue(mapping.planKey&&mapping.threadId&&mapping.hostId&&mapping.stepKeys?.length&&mapping.worktreePath&&mapping.branch,'FIXED_MAPPING_REQUIRED');
 const key=hash([mapping.planKey,mapping.hostId,mapping.threadId]);const previous=ledger.mappings?.find(m=>m.key===key);
 ledger.mappings??=[];if(previous){ledger.mappingHistory??=[];if(hash(previous.mapping)!==hash(mapping))ledger.mappingHistory.push(structuredClone(previous));previous.mapping=structuredClone(mapping);}else ledger.mappings.push({key,mapping:structuredClone(mapping)});
 return ledger.mappings.find(m=>m.key===key);
}
export async function runHostOperation(ledger,operation,adapter={},checkpoint=async()=>{}){
 requireValue(operation.operationId&&operation.kind,'OPERATION_ID_REQUIRED');
 const {operationId,...intent}=operation;const contentHash=hash(intent);ledger.operations??=[];
 let entry=ledger.operations.find(x=>x.operationId===operationId);
 requireValue(!entry||entry.contentHash===contentHash,'OPERATION_IDEMPOTENCY_CONFLICT');
 if(entry?.status==='succeeded')return structuredClone(entry);
 if(!entry){entry={operationId,contentHash,intent:structuredClone(intent),status:'pending',attempts:[],targetId:null,resultUnknown:false};ledger.operations.push(entry);}
 if(operation.kind==='createChat'&&operation.explicitUserAuthorization!==true){entry.status='unsupported';entry.reason='NEW_CHAT_REQUIRES_EXPLICIT_USER_AUTHORIZATION';return structuredClone(entry);}
 if(operation.kind==='sendMessage'&&operation.explicitUserAuthorization!==true){entry.status='unsupported';entry.reason='MESSAGE_REQUIRES_EXPLICIT_USER_AUTHORIZATION';return structuredClone(entry);}
 const action=adapter[operation.kind];if(typeof action!=='function'){entry.status='unsupported';entry.reason='HOST_CAPABILITY_UNAVAILABLE';return structuredClone(entry);}
 if(entry.resultUnknown||entry.status==='pending'&&entry.attempts.length||operation.kind.startsWith('create')&&entry.targetId){
  if(typeof adapter.reconcile!=='function'){entry.status='pending';entry.reason='QUERY_ORIGINAL_OPERATION_BEFORE_RETRY';return structuredClone(entry);}
  const recovered=await adapter.reconcile(structuredClone(entry));
  if(recovered?.state==='succeeded'){requireValue(recovered.targetId||!operation.kind.startsWith('create'),'FIXED_TARGET_ID_REQUIRED');entry.status='succeeded';entry.targetId=recovered.targetId??entry.targetId;entry.result=structuredClone(recovered.result??entry.result??{});entry.resultUnknown=false;await checkpoint(ledger);return structuredClone(entry);}
  if(recovered?.state!=='notSubmitted'){entry.status='pending';return structuredClone(entry);}entry.resultUnknown=false;
 }
 const attempt={at:new Date().toISOString(),status:'pending'};entry.attempts.push(attempt);entry.status='pending';
 // 日期：2026-11-12。先持久化意图，再调用外部工具；崩溃后 pending 必须先对账。
 entry.resultUnknown=true;await checkpoint(ledger);
 try{
  const result=await action({...structuredClone(operation),reuseTargetId:entry.targetId});
  requireValue(!operation.kind.startsWith('create')||result?.targetId,'FIXED_TARGET_ID_REQUIRED');
  entry.targetId=result?.targetId??entry.targetId??operation.targetId??null;entry.result=structuredClone(result??{});entry.status='succeeded';entry.resultUnknown=false;attempt.status='succeeded';
 }catch(error){entry.status=error.resultUnknown?'pending':'failed';entry.resultUnknown=!!error.resultUnknown;entry.reason=error.message;entry.targetId=error.targetId??entry.targetId;attempt.status=entry.status;}
 await checkpoint(ledger);
 return structuredClone(entry);
}
