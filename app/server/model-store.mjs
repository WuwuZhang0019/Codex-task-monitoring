import { readFile, mkdir, writeFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateRelationships } from './relationships.mjs';
import { HttpError } from './validation.mjs';
import {applyReceiptCommand,inspectReceipts} from './receipts.mjs';
import {applyStart,inspectMonitor,reconcileLifecycle} from './monitor.mjs';
import {capturePlanSnapshots} from './plan-diff.mjs';

async function atomic(file,value){
  const temporary=`${file}.${randomUUID()}.tmp`;
  try{await writeFile(temporary,JSON.stringify(value,null,2),'utf8');await rename(temporary,file);}
  finally{await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}

export function legacyModel(project) {
  const taskId = `legacy:${project.id}`;
  return { folders:[], tasks:[{id:taskId,folderId:null,name:project.name,goal:project.goal,acceptance:[]}], chats:[],plans:[],
    stations:project.steps.map(s=>({id:s.id,taskId,code:s.id,planId:null,title:s.title,scope:s.purpose,acceptance:s.acceptance,
      dependsOn:s.dependsOn,successors:project.steps.filter(x=>x.dependsOn.includes(s.id)).map(x=>x.id),
      report:structuredClone(s),verification:'pending'})),
    initialPlanId:null,currentPlanId:null,acceptance:[],legacy:structuredClone(project),migration:{version:1,sourceHash:createHash('sha256').update(JSON.stringify(project)).digest('hex') } };
}

export async function createModelStore(directory, projects) {
  await mkdir(directory,{recursive:true});
  let queue=Promise.resolve();
  const fileFor=id=>path.join(directory,`${id}.json`);
  async function read(id) {
    const project=projects.get(id);
    try {const value=JSON.parse(await readFile(fileFor(id),'utf8'));if(!Number.isSafeInteger(value.revision)||value.revision<1)throw new Error('关系存储版本损坏');validateRelationships(value.model);return value;}
    catch(error){if(error.code==='ENOENT'){
      try{await stat(`${fileFor(id)}.bak`);throw new Error('关系主文件缺失，发现备份；请恢复，不会自动重建');}catch(e){if(e.code!=='ENOENT')throw e;}
      return {revision:0,model:legacyModel(project)};
    }throw error;}
  }
  function update(id,body,receiptCommand=false) {
    const operation=queue.then(async()=>{
      const old=await read(id);
      if(receiptCommand==='sync'&&old.revision===0)return old;
      if(receiptCommand!=='sync'&&(!body||body.revision!==old.revision))throw new HttpError(409,'关系版本冲突，请重新读取');
      const candidate=receiptCommand==='sync'?old.model:receiptCommand==='start'?applyStart(id,old.model,body):receiptCommand?applyReceiptCommand(id,old.model,body):body.model;
      if(candidate===null)return old;
      const model=validateRelationships(candidate);
      if(!receiptCommand){if(old.model.receiptLog)model.receiptLog=old.model.receiptLog;else delete model.receiptLog;}
      if(receiptCommand!=='start'){if(old.model.lifecycle)model.lifecycle=old.model.lifecycle;else delete model.lifecycle;}
      for(const key of ['initialPlanId','currentPlanId'])if(model[key]!==null&&!model.plans.some(p=>p.id===model[key]))throw new HttpError(400,'项目方案引用不存在');
      if(old.revision>0){
        if(old.model.initialPlanId!==null&&model.initialPlanId!==old.model.initialPlanId)throw new HttpError(400,'初始方案引用不可覆盖');
        for(const plan of old.model.plans)if(JSON.stringify(model.plans.find(p=>p.id===plan.id))!==JSON.stringify(plan))throw new HttpError(400,'已有方案版本不可覆盖或删除');
        for(const task of old.model.tasks){const next=model.tasks.find(t=>t.id===task.id);if(!next||(task.folderId!==null&&next.folderId!==task.folderId))throw new HttpError(400,'已有任务不可删除或迁移文件夹');}
        for(const task of old.model.tasks)if(task.initialGoal&&model.tasks.find(t=>t.id===task.id)?.initialGoal!==task.initialGoal)throw new HttpError(400,'原始任务目标不可覆盖');
        for(const station of old.model.stations){const next=model.stations.find(s=>s.id===station.id);if(!next||next.taskId!==station.taskId||next.code!==station.code)throw new HttpError(400,'已有站点身份不可删除或改写');}
      }
      for(const station of model.stations){
        const previous=old.model.stations.find(s=>s.id===station.id);
        if(previous?.report)station.report=structuredClone(previous.report);
        else delete station.report;
        station.verification='pending';
      }
      // Legacy evidence and report history are immutable migration provenance.
      model.legacy=old.model.legacy;model.migration=old.model.migration;
      // Never trust client-supplied historical station snapshots. Observe versions
      // only on relationship writes; receipt/monitor reads preserve prior history.
      model.planSnapshots=receiptCommand?structuredClone(old.model.planSnapshots??[]):capturePlanSnapshots(old.model,model,old.revision);
      const reconciled=reconcileLifecycle(id,model);
      if(receiptCommand==='sync'&&JSON.stringify(reconciled)===JSON.stringify(old.model))return old;
      const value={revision:old.revision+1,model:reconciled},file=fileFor(id);
      if(old.revision===0)await writeFile(`${file}.legacy.json`,JSON.stringify(old.model.legacy,null,2),{flag:'wx',encoding:'utf8'}).catch(async e=>{if(e.code!=='EEXIST')throw e;if(JSON.stringify(JSON.parse(await readFile(`${file}.legacy.json`,'utf8')))!==JSON.stringify(old.model.legacy))throw new Error('迁移快照不匹配，请先恢复或核对来源');});
      else await atomic(`${file}.bak`,old);
      await atomic(file,value);
      return structuredClone(value);
    });queue=operation.catch(()=>{});return operation;
  }
  return {get:read,update,
    inspect:async id=>{const value=await read(id);return {revision:value.revision,...inspectReceipts(id,value.model)};},
    monitor:async id=>{const value=await update(id,null,'sync');return {...inspectMonitor(id,value.model),revision:value.revision,model:value.model};},
    start:(id,body)=>update(id,body,'start'),
    command:(id,body)=>update(id,body,true)};
}
