// 日期：2026-11-11。只修改已明确识别的执行编号和引用范围，不猜测自然语言步骤。
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
function requireValue(test, code) { if (!test) throw new Error(code); }
function letters(index) { let out=''; for(let n=index+1;n;n=Math.floor((n-1)/26))out=String.fromCharCode(65+(n-1)%26)+out;return out; }
function suffix(index) { return letters(index).toLowerCase(); }

// nodes 的 key 是方案内稳定本地键；parentKey/dependencies/reference.targetKey 均引用该键。
export function normalizePlan({ text, expectedSha256, nodes, references=[], previous=[] }) {
  requireValue(sha256(text)===expectedSha256,'SOURCE_CHANGED');
  requireValue(Array.isArray(nodes)&&nodes.length>0,'STEPS_REQUIRED');
  const byKey=new Map(nodes.map(n=>[n.key,n]));
  requireValue(byKey.size===nodes.length&&nodes.every(n=>typeof n.key==='string'&&n.key&&n.title&&n.locator),'INVALID_STEP_IDENTITY');
  const old=new Map(previous.map(n=>[n.key,n]));
  requireValue(old.size===previous.length,'DUPLICATE_MAPPING');
  requireValue(previous.every(n=>byKey.has(n.key)),'HISTORY_REQUIRED');
  for(const n of nodes){
    requireValue(!n.parentKey||byKey.has(n.parentKey)&&!byKey.get(n.parentKey).parentKey,'INVALID_PARENT');
    requireValue(!old.has(n.key)||old.get(n.key).parentKey===(n.parentKey??null),'IDENTITY_CHANGED');
    requireValue((n.dependsOn??[]).every(k=>byKey.has(k)),'MISSING_DEPENDENCY');
    requireValue(Number.isSafeInteger(n.order)&&n.order>=1,'POSITIVE_INTEGER_ORDER_REQUIRED');
  }
  const active=new Set(),visited=new Set();
  function visit(key){requireValue(!active.has(key),'DEPENDENCY_CYCLE');if(visited.has(key))return;active.add(key);const n=byKey.get(key);for(const k of [...(n.dependsOn??[]),...nodes.filter(x=>x.parentKey===key).map(x=>x.key)])visit(k);active.delete(key);visited.add(key);}
  for(const n of nodes)visit(n.key);
  const mapping=new Map(),used=new Set(previous.map(n=>n.code));let nextStage=0;
  const stages=nodes.filter(n=>!n.parentKey).sort((a,b)=>a.order-b.order);
  requireValue(new Set(stages.map(n=>n.order)).size===stages.length,'DUPLICATE_ORDER');
  for(const n of stages){let code=old.get(n.key)?.code;if(!code){while(used.has(letters(nextStage)))nextStage++;code=letters(nextStage++);}requireValue(/^[A-Z]+$/.test(code),'INVALID_STAGE_CODE');mapping.set(n.key,{...old.get(n.key),key:n.key,code,parentKey:null});used.add(code);}
  for(const stage of stages){
    const children=nodes.filter(n=>n.parentKey===stage.key).sort((a,b)=>a.order-b.order);
    requireValue(new Set(children.map(n=>n.order)).size===children.length,'DUPLICATE_ORDER');
    const stageCode=mapping.get(stage.key).code;let next=1;
    for(const n of children){
      let code=old.get(n.key)?.code;
      if(!code&&previous.length&&children.some(other=>old.has(other.key)&&other.order>n.order))requireValue(n.insertAfterKey,'INSERT_ANCHOR_REQUIRED');
      if(!code&&n.insertAfterKey){
        const anchor=mapping.get(n.insertAfterKey)??old.get(n.insertAfterKey);
        requireValue(anchor?.parentKey===stage.key,'INVALID_INSERT_ANCHOR');let i=0;
        do{code=anchor.code+'-'+suffix(i++);}while(used.has(code));
      }
      if(!code){while(used.has(stageCode+'-'+String(next).padStart(2,'0')))next++;code=stageCode+'-'+String(next++).padStart(2,'0');}
      requireValue(code.startsWith(stageCode+'-'),'IDENTITY_CHANGED');mapping.set(n.key,{...old.get(n.key),key:n.key,code,parentKey:stage.key});used.add(code);
    }
  }
  requireValue(new Set([...mapping.values()].map(n=>n.code)).size===mapping.size,'DUPLICATE_CODE');
  const edits=[];
  function edit(range,targetKey){const target=mapping.get(targetKey);requireValue(target,'MISSING_REFERENCE');requireValue(Number.isInteger(range.start)&&Number.isInteger(range.end)&&range.start>=0&&range.end>=range.start&&range.end<=text.length&&text.slice(range.start,range.end)===range.expected,'REFERENCE_CHANGED');edits.push({...range,replacement:target.code,targetKey});}
  for(const n of nodes){requireValue(n.codeRange,'CODE_RANGE_REQUIRED');edit(n.codeRange,n.key);const m=mapping.get(n.key);Object.assign(m,{originalCode:old.get(n.key)?.originalCode??n.originalCode??null,title:n.title,locator:n.locator,order:n.order,stepId:old.get(n.key)?.stepId??null,dependsOn:[...(n.dependsOn??[])],status:n.status??'pending',acceptance:n.acceptance??old.get(n.key)?.acceptance??null});}
  for(const r of references)edit(r,r.targetKey);
  edits.sort((a,b)=>a.start-b.start||a.end-b.end);
  for(let i=1;i<edits.length;i++)requireValue(edits[i].start>=edits[i-1].end&&!(edits[i].start===edits[i-1].start),'OVERLAPPING_EDIT');
  let output=text;for(const e of edits.toReversed())output=output.slice(0,e.start)+e.replacement+output.slice(e.end);
  return {date:new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date()),beforeSha256:expectedSha256,afterSha256:sha256(output),text:output,mapping:[...mapping.values()],edits:edits.filter(e=>e.expected!==e.replacement)};
}

export function registrationSnapshot(result,{projectKey,planKey,name,sourcePath,version,context,routes}){
  requireValue(projectKey&&planKey&&name&&sourcePath&&version&&context,'REGISTRATION_CONTEXT_REQUIRED');
  requireValue(result.mapping.every(n=>typeof n.acceptance==='string'&&n.acceptance.trim()),'ACCEPTANCE_REQUIRED');
  const timestamp=result.date+'T00:00:00+08:00',stages=result.mapping.filter(n=>!n.parentKey).sort((a,b)=>a.order-b.order);
  return {schemaVersion:'light-1.0',date:result.date,mode:'local',revision:null,generatedAt:timestamp,
    projects:[{key:projectKey,id:null,name,planKeys:[planKey],revision:null}],
    plans:[{key:planKey,id:null,projectKey,name,stageCount:stages.length,stageKeys:stages.map(n=>n.key),source:{path:sourcePath,version,sha256:result.afterSha256,locator:'规范化映射及明确依赖',trust:'declared'},endConditions:[]}],
    steps:result.mapping.map(n=>({key:n.key,id:null,projectKey,planKey,parentKey:n.parentKey,code:n.code,originalCode:n.originalCode,sourceLocator:n.locator,title:n.title,order:n.order,required:true,dependsOn:n.dependsOn,status:'pending',acceptance:'pending',sync:'pendingSync',conditions:[{conditionId:n.key+'/exit',text:n.acceptance,required:true,result:'pending',evidenceIds:[]}],evidence:[],blockers:[],executionKey:null,bindingKey:null,updatedAt:timestamp})),
    routes:(routes??[{key:planKey+'/main',label:name,stepKeys:stages.map(n=>n.key),context}]).map((r,i)=>({...r,id:null,projectKey,planKey,order:i+1,sourceStepKey:r.sourceStepKey??null,returnStepKey:r.returnStepKey??null})),
    bindings:[],executions:[],supplements:[],events:[],uiPreferences:{collapsedKeys:[],selectedStepKey:null,focusedRouteKey:null,scrollByProject:{}}};
}

// 默认只写候选；写回时校验来源并使用独占协作锁和同目录原子替换。
export async function applyNormalizedFile(file, result) {
  const lock=file+'.normalize.lock',temporary=file+'.normalize-'+randomUUID()+'.tmp';
  const handle=await open(lock,'wx');let prepared=false;
  try{
    requireValue(sha256(await readFile(file,'utf8'))===result.beforeSha256,'SOURCE_CHANGED');
    await writeFile(temporary,result.text,{encoding:'utf8',flag:'wx'});prepared=true;
    requireValue(sha256(await readFile(file,'utf8'))===result.beforeSha256,'SOURCE_CHANGED');
    await rename(temporary,file);prepared=false;
  }finally{await handle.close();await unlink(lock);if(prepared)await unlink(temporary);}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [manifestPath,sourcePath,outputPath]=process.argv.slice(2);requireValue(manifestPath&&sourcePath&&outputPath,'USAGE: node normalize-plan.mjs manifest.json source.md candidate.json');
  const input=JSON.parse(await readFile(manifestPath,'utf8'));const result=normalizePlan({...input,text:await readFile(sourcePath,'utf8')});
  await writeFile(outputPath,JSON.stringify(result,null,2)+'\n','utf8');console.log(JSON.stringify({beforeSha256:result.beforeSha256,afterSha256:result.afterSha256,steps:result.mapping.length,edits:result.edits.length}));
}
