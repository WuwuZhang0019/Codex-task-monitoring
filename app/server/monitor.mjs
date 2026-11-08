import {randomUUID} from 'node:crypto';
import {digest,inspectReceipts} from './receipts.mjs';
import {HttpError} from './validation.mjs';

const nonempty=v=>typeof v==='string'&&!!v.trim();
const initialCheck=(review,criterion,version)=>{
 const c=review?.taskChecks?.find(c=>c.criterion===criterion);
 return c?.result==='passed'&&c.evidenceIds?.length>0&&c.evidenceIds.every(id=>review.evidence.some(e=>e.id===id&&e.result==='valid'&&e.deliveryVersion===version&&nonempty(e.location)&&nonempty(e.method)&&nonempty(e.reason)));
};
export const startScope=s=>digest({id:s.id,taskId:s.taskId,planId:s.planId,title:s.title,scope:s.scope,acceptance:s.acceptance,dependsOn:s.dependsOn});

export function inspectMonitor(projectId,m){
 const inspection=inspectReceipts(projectId,m),{results,log}=inspection,life=m.lifecycle??{starts:[],closures:[],events:[]};
 function edgeReady(from,to){const r=results[from];return r?.passed&&r.conclusion!=='G'&&r.handoffs.some(h=>h.stationId===to&&h.match==='matched');}
 const stations=m.stations.map(s=>{
  const r=results[s.id],task=m.tasks.find(t=>t.id===s.taskId),sourceBound=task?.folderId&&m.chats.some(c=>c.taskId===task.id&&c.folderId===task.folderId);
  const waiting=s.dependsOn.filter(id=>!edgeReady(id,s.id));
  const ready=!!sourceBound&&!!s.planId&&s.planId===m.currentPlanId&&!waiting.length;
  const receipt=log.receipts.find(e=>e.id===r.receiptId);
  const start=life.starts.filter(e=>e.stationId===s.id&&e.scopeHash===startScope(s)&&m.chats.some(c=>c.id===e.sourceId&&c.taskId===s.taskId&&c.folderId===task?.folderId)).at(-1);
  const active=ready&&start&&(!receipt||start.sequence>(life.receiptPositions?.[receipt.id]??-1));
  let color='dark',state='todo',label=ready?'可开始':'等待依赖';
  if(!sourceBound||!s.planId||s.planId!==m.currentPlanId)label='待绑定来源或当前方案';
  if(receipt||s.report?.status==='done'||s.report?.status==='active'){state='pending';label='待核验';}
  if(r.acceptance.result==='failed'||r.conclusion==='A'){state='blocked';label='验收失败或阻塞';}
  if(active){color='green';state='active';label='进行中';}
  if(r.localPassed){color='red';state='done';label='已完成';}
  if(waiting.length){if(!r.localPassed)color='dark';label=r.localPassed?'已验收，等待前置':'等待依赖';}
  if(r.conclusion==='G')label=r.localPassed?'已完成，交接偏离':'路线偏离';
  return {id:s.id,taskId:s.taskId,code:s.code,title:s.title,scope:s.scope,dependsOn:s.dependsOn,color,state,label,ready,waiting,start,conclusion:r.conclusion,reason:r.reason};
 });
 const initial=m.plans.find(p=>p.id===m.initialPlanId),current=m.plans.find(p=>p.id===m.currentPlanId);
 const tasks=m.tasks.map(task=>{
  const own=m.stations.filter(s=>s.taskId===task.id),terminals=own.filter(s=>!s.successors.some(id=>m.stations.find(x=>x.id===id)?.taskId===task.id));
  const originalKnown=nonempty(task.initialGoal);
  const proofs=own.map(s=>({stationId:s.id,receiptId:results[s.id]?.receiptId,reviewId:results[s.id]?.reviewId}));
  const goalChecked=terminals.some(s=>{const r=results[s.id],v=log.reviews.find(v=>v.id===r.reviewId),e=log.receipts.find(e=>e.id===r.receiptId);return v&&e&&initialCheck(v.review,`原始任务目标：${task.initialGoal}`,e.receipt.deliveryVersion);});
  const eligible=originalKnown&&goalChecked&&own.length>0&&own.every(s=>results[s.id].passed)&&terminals.length>0&&terminals.every(s=>['E','F'].includes(results[s.id].conclusion));
  return {id:task.id,name:task.name,eligible,originalGoal:task.initialGoal??null,currentGoal:task.goal??null,actual:own.map(s=>log.receipts.find(e=>e.id===results[s.id].receiptId)?.receipt.actual).filter(Boolean),proofs,handoff:task.handoff||'无',originalExpectation:eligible?'满足':'待核验',deviation:task.initialGoal===task.goal?'无目标文字差异':'原始目标与当前目标有差异，分别保留',reason:!originalKnown?'原始任务目标待确认':!goalChecked?'原始任务目标缺少有效对照证据':eligible?'任务全部必要步骤及终点通过':'站点、交接或终点条件尚未全部通过'};
 });
 const projectEligible=tasks.length>0&&tasks.every(t=>t.eligible)&&nonempty(initial?.goal)&&stations.some(s=>s.conclusion==='F');
 const project={id:projectId,eligible:projectEligible,originalGoal:initial?.goal??null,currentGoal:current?.goal??null,actual:tasks.flatMap(t=>t.actual),proofs:tasks.flatMap(t=>t.proofs),handoff:'无',originalExpectation:projectEligible?'满足':'待核验',deviation:initial?.goal===current?.goal?'无目标文字差异':'初始与当前方案目标有差异，初始目标验收仍须通过',reason:projectEligible?'任务交付与项目级预设验收全部通过':'任务交付或项目级原始目标与验收尚未全部通过'};
 for(const target of [...tasks,project]){
  const kind=target===project?'project':'task',closed=life.closures.filter(c=>c.kind===kind&&c.targetId===target.id).at(-1);
  const proofHash=digest(target);
  target.status=closed?(target.eligible&&closed.proofHash===proofHash?'closed':'recheck'):'open';
  target.closure=closed??null;
 }
 return {ruleVersion:'m04-v1',stations,tasks,project,lifecycle:life,inspection};
}

export function reconcileLifecycle(projectId,model){
 const m=structuredClone(model),life=m.lifecycle??{starts:[],closures:[],events:[],receiptPositions:{}};m.lifecycle=life;
 life.receiptPositions??={};life.observed??={};
 for(const event of m.receiptLog?.events??[])if(!life.observed[event.id]){
  const receiptId=event.receiptId??m.receiptLog.reviews.find(v=>v.id===event.reviewId)?.receiptId;
  life.events.push({id:randomUUID(),type:'verification-updated',sourceEventId:event.id,time:event.time});
  if(receiptId)life.receiptPositions[receiptId]=life.events.length;
  life.observed[event.id]=true;
 }
 for(const e of m.receiptLog?.receipts??[])if(life.receiptPositions[e.id]===undefined)life.receiptPositions[e.id]=life.events.length;
 const view=inspectMonitor(projectId,m);
 for(const [kind,targets] of [['task',view.tasks],['project',[view.project]]])for(const target of targets){
  const {status,closure,...snapshot}=target,proofHash=digest(snapshot),last=life.closures.filter(c=>c.kind===kind&&c.targetId===target.id).at(-1);
  const time=new Date().toISOString();
  if(target.eligible&&(!last||last.proofHash!==proofHash)){
   const record={...snapshot,id:randomUUID(),kind,targetId:target.id,proofHash,ruleVersion:'m04-v1',time};life.closures.push(record);life.events.push({id:randomUUID(),type:'closed',kind,targetId:target.id,closureId:record.id,time});
  }else if(last&&(!target.eligible||last.proofHash!==proofHash)){
   const key=digest({closureId:last.id,proofHash});if(!life.events.some(e=>e.type==='recheck'&&e.key===key))life.events.push({id:randomUUID(),type:'recheck',kind,targetId:target.id,closureId:last.id,key,time,reason:target.reason});
  }
 }
 return m;
}

export function applyStart(projectId,model,body){
 const m=reconcileLifecycle(projectId,model),view=inspectMonitor(projectId,m),station=view.stations.find(s=>s.id===body.stationId),head=m.stations.find(s=>s.id===body.stationId),chat=m.chats.find(c=>c.id===body.sourceId),task=head&&m.tasks.find(t=>t.id===head.taskId);
 if(!station||!chat||chat.taskId!==head.taskId||chat.folderId!==task.folderId||!nonempty(body.evidence)||!nonempty(body.executionId))throw new HttpError(400,'实际开始需正确站点、聊天来源、执行标识和开始证据');
 const previous=m.lifecycle.starts.find(e=>e.executionId===body.executionId);
 if(previous){if(previous.stationId!==body.stationId||previous.sourceId!==body.sourceId||previous.evidence!==body.evidence)throw new HttpError(400,'执行标识已用于其他开始记录');return null;}
 if(!station.ready||station.state==='done'||station.state==='active'||view.tasks.find(t=>t.id===head.taskId)?.status==='closed')throw new HttpError(400,'本站前置未满足、已开始或已经完成，不可重复登记开始');
 const entry={id:randomUUID(),stationId:head.id,sourceId:chat.id,executionId:body.executionId,evidence:body.evidence,scopeHash:startScope(head),sequence:m.lifecycle.events.length+1,time:new Date().toISOString()};
 m.lifecycle.starts.push(entry);m.lifecycle.events.push({id:randomUUID(),type:'started',stationId:head.id,sourceId:chat.id,startId:entry.id,time:entry.time});return m;
}
