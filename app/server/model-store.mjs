import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateRelationships } from './relationships.mjs';
import { HttpError } from './validation.mjs';

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
    try {const value=JSON.parse(await readFile(fileFor(id),'utf8'));validateRelationships(value.model);return value;}
    catch(error){if(error.code==='ENOENT')return {revision:0,model:legacyModel(project)};throw error;}
  }
  return {get:read,update(id,body) {
    const operation=queue.then(async()=>{
      const old=await read(id);
      if(!body||body.revision!==old.revision)throw new HttpError(409,'关系版本冲突，请重新读取');
      const model=validateRelationships(body.model);
      for(const key of ['initialPlanId','currentPlanId'])if(model[key]!==null&&!model.plans.some(p=>p.id===model[key]))throw new HttpError(400,'项目方案引用不存在');
      if(old.revision>0){
        if(model.initialPlanId!==old.model.initialPlanId)throw new HttpError(400,'初始方案引用不可覆盖');
        for(const plan of old.model.plans)if(JSON.stringify(model.plans.find(p=>p.id===plan.id))!==JSON.stringify(plan))throw new HttpError(400,'已有方案版本不可覆盖或删除');
      }
      // Legacy evidence and report history are immutable migration provenance.
      model.legacy=old.model.legacy;model.migration=old.model.migration;
      const value={revision:old.revision+1,model},file=fileFor(id),temporary=`${file}.${randomUUID()}.tmp`;
      if(old.revision===0)await writeFile(`${file}.legacy.json`,JSON.stringify(old.model.legacy,null,2),{flag:'wx',encoding:'utf8'}).catch(e=>{if(e.code!=='EEXIST')throw e;});
      else await writeFile(`${file}.bak`,JSON.stringify(old), 'utf8');
      await writeFile(temporary,JSON.stringify(value,null,2),'utf8');
      await rename(temporary,file);
      return structuredClone(value);
    });queue=operation.catch(()=>{});return operation;
  }};
}
