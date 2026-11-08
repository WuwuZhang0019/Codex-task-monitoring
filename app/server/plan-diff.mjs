import {digest} from './receipts.mjs';

const stationHead=s=>Object.fromEntries(['id','taskId','code','title','scope','acceptance','dependsOn','successors','chapter'].map(k=>[k,s[k]??null]));

// These are observed, server-owned snapshots, not a reconstruction of missing history.
export function capturePlanSnapshots(old,model,revision){
 const snapshots=structuredClone(old.planSnapshots??[]);
 for(const [m,rev] of [[old,revision],[model,revision+1]]){
  const id=m.currentPlanId;
  if(id&&m.plans.some(p=>p.id===id)&&!snapshots.some(p=>p.planId===id))snapshots.push({planId:id,revision:rev,time:new Date().toISOString(),stations:m.stations.filter(s=>s.planId===id).map(stationHead)});
 }
 return snapshots;
}

export function comparePlans(m,monitor){
 const initial=m.plans.find(p=>p.id===m.initialPlanId)??null,current=m.plans.find(p=>p.id===m.currentPlanId)??null;
 const initialSnapshot=m.planSnapshots?.find(p=>p.planId===initial?.id)??null;
 const currentStations=m.stations.filter(s=>s.planId===current?.id).map(stationHead);
 const before=initialSnapshot?.stations??(initial?.id===current?.id?currentStations:null);
 const stationChanges=before?Array.from(new Set([...before,...currentStations].map(s=>s.id))).flatMap(id=>{
  const a=before.find(s=>s.id===id)??null,b=currentStations.find(s=>s.id===id)??null;
  return digest(a)===digest(b)?[]:[{id,before:a,after:b}];
 }):null;
 const fields=['source','sourcePath','chapter','goal','acceptance'].map(field=>({field,before:initial?.[field]??null,after:current?.[field]??null,changed:digest(initial?.[field]??null)!==digest(current?.[field]??null)}));
 const rechecks=Object.values(monitor.inspection.results).filter(r=>r.acceptance.result!=='passed').map(r=>({stationId:r.stationId,reason:r.reason||'必要验收尚未通过'}));
 const changed=fields.some(f=>f.changed)||!!stationChanges?.length;
 return {initial,current,initialSnapshot,currentStations,stationChanges,fields,rechecks,
  taskGoals:m.tasks.map(t=>({id:t.id,initial:t.initialGoal??null,current:t.goal??null})),
  currentConformance:monitor.project.eligible?'满足':'待核验：当前必要验收或项目级条件尚未全部通过',
  initialConformance:monitor.project.originalExpectation,
  impact:(!initial||!current||stationChanges===null)?'待核验：缺少方案或历史站点快照，不能重建旧站点目标和验收；原文仍可对照':changed?'存在差异：受影响站点、依赖和证据须按当前头部重新核验；差异本身不代表已批准变更':'未发现已保存内容的差异；不替代实际验收',
  declaredImpact:current?.impact||'待核验：未登记变更影响',
  history:{receipts:m.receiptLog?.receipts.length??0,reviews:m.receiptLog?.reviews.length??0,closures:monitor.lifecycle.closures.length}};
}
