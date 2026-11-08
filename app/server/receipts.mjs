import {createHash,randomUUID} from 'node:crypto';
import {HttpError} from './validation.mjs';

const fail=message=>{throw new HttpError(400,message);};
const nonempty=v=>typeof v==='string'&&!!v.trim();
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const digest=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const list=(v,label)=>{if(!Array.isArray(v))fail(`${label} 必须是数组`);return v;};
const text=(v,label)=>{if(!nonempty(v))fail(`${label} 必须填写`);};
const record=(v,label)=>{if(!v||typeof v!=='object'||Array.isArray(v))fail(`${label} 必须是对象`);};
export function headDigest(model,receipt){
 const station=model.stations.find(s=>s.id===receipt.stationId);
 return digest({station,task:model.tasks.find(t=>t.id===receipt.taskId),folder:model.folders.find(f=>f.id===receipt.folderId),source:model.chats.find(c=>c.id===receipt.sourceId),plan:model.plans.find(p=>p.id===receipt.planId),currentPlanId:model.currentPlanId,acceptance:model.acceptance,successors:station?.successors.map(id=>model.stations.find(s=>s.id===id))});
}
function identity(projectId,m,r){
 const s=m.stations.find(s=>s.id===r.stationId),t=m.tasks.find(t=>t.id===r.taskId),c=m.chats.find(c=>c.id===r.sourceId);
 if(r.projectId!==projectId||!s||!t||s.taskId!==t.id||!t.folderId||r.folderId!==t.folderId||!c||c.taskId!==t.id||c.folderId!==r.folderId)return '项目、文件夹、任务、站点或聊天归属不匹配';
 if(!s.planId||s.planId!==r.planId||r.planId!==m.currentPlanId)return '方案版本未绑定或不适用于当前版本';
 return '';
}
export function applyReceiptCommand(projectId,model,body){
 const m=structuredClone(model),log=m.receiptLog??{receipts:[],reviews:[],invalidations:[],events:[]};m.receiptLog=log;
 const time=new Date().toISOString();
 if(body.action==='import'){
  const r=body.receipt;if(!r||typeof r!=='object')fail('缺少结构化回执');
  for(const k of ['projectId','folderId','taskId','stationId','planId','sourceId','deliveryVersion','raw','actual'])text(r[k],k);
  list(r.blockers,'未决事项').forEach(v=>text(v,'未决事项'));
  const nextIds=new Set();list(r.next,'下一站').forEach(n=>{record(n,'下一站');for(const k of ['stationId','goal','scope','delivery'])text(n[k],`下一站 ${k}`);if(nextIds.has(n.stationId))fail('回执后继重复');nextIds.add(n.stationId);});
  list(r.checks,'报告验收项').forEach(c=>{record(c,'验收项');text(c.criterion,'验收项');if(!['passed','failed','pending'].includes(c.result))fail('报告验收结果非法');});
  const hash=digest(r);if(log.receipts.some(x=>x.hash===hash))return null;
  const entry={id:randomUUID(),hash,time,headHash:headDigest(m,r),receipt:structuredClone(r),identityIssue:identity(projectId,m,r)};
  log.receipts.push(entry);log.events.push({id:randomUUID(),type:'receipt-imported',receiptId:entry.id,time});
 }else if(body.action==='review'){
  const entry=log.receipts.find(x=>x.id===body.receiptId);if(!entry)fail('回执不存在');
  const issue=identity(projectId,m,entry.receipt);if(issue)fail(issue);
  const v=body.review;if(!v||typeof v!=='object')fail('缺少核验记录');text(v.reviewer,'核验人');text(v.method,'核验方法');
  for(const key of ['checks','taskChecks','projectChecks']){
   const seen=new Set();list(v[key],key).forEach(c=>{record(c,'验收项');text(c.criterion,'验收项');if(seen.has(c.criterion))fail('重复验收项');seen.add(c.criterion);if(!['passed','failed','pending'].includes(c.result))fail('核验结果非法');if(c.result!=='pending')text(c.reason,'核验依据');list(c.evidenceIds,'证据引用').forEach(id=>text(id,'证据标识'));});
  }
  const ids=new Set();list(v.evidence,'证据登记').forEach(e=>{record(e,'证据');text(e.id,'证据标识');if(e.result!=='pending')for(const k of ['location','deliveryVersion','method','reason'])text(e[k],`证据 ${k}`);if(ids.has(e.id))fail('证据编号重复');ids.add(e.id);if(!['valid','invalid','pending'].includes(e.result))fail('证据核验结果非法');});
  const targets=new Set();list(v.handoffs,'头尾核验').forEach(h=>{record(h,'交接');text(h.stationId,'后继站点');if(h.result!=='pending')text(h.reason,'头尾匹配依据');if(targets.has(h.stationId))fail('重复交接目标');targets.add(h.stationId);if(!['matched','mismatch','pending'].includes(h.result))fail('交接结果非法');});
  const hash=digest({receiptId:entry.id,headHash:headDigest(m,entry.receipt),review:v}),last=log.reviews.filter(x=>x.receiptId===entry.id).at(-1);if(last?.hash===hash&&!log.invalidations.some(i=>i.reviewId===last.id))return null;
  const review={id:randomUUID(),receiptId:entry.id,hash,headHash:headDigest(m,entry.receipt),ruleVersion:'m03-v1',time,review:v};
  log.reviews.push(review);log.events.push({id:randomUUID(),type:'review-recorded',reviewId:review.id,time});
 }else if(body.action==='invalidate'){
  text(body.reason,'失效原因');if(!log.reviews.some(v=>v.id===body.reviewId))fail('核验记录不存在');
  if(log.invalidations.some(v=>v.reviewId===body.reviewId))return null;
  log.invalidations.push({reviewId:body.reviewId,reason:body.reason,time});log.events.push({id:randomUUID(),type:'review-invalidated',reviewId:body.reviewId,time});
 }else fail('不支持的回执操作');
 return m;
}

export function inspectReceipts(projectId,m){
 const log=m.receiptLog??{receipts:[],reviews:[],invalidations:[],events:[]},results={};
 const latest=s=>log.receipts.filter(e=>e.receipt.stationId===s.id&&!identity(projectId,m,e.receipt)).at(-1);
 const initial=m.plans.find(p=>p.id===m.initialPlanId),current=m.plans.find(p=>p.id===m.currentPlanId);
 const projectCriteria=[...new Set([...(m.acceptance??[]),...(initial?.acceptance??[]),...(current?.acceptance??[]),...(nonempty(initial?.goal)?[`原始目标：${initial.goal}`]:[])])];
 function criteria(required,checks,evidence,version){
  if(!Array.isArray(required)||!required.length)return {result:'pending',reason:'缺少既定验收条件'};
  const outcomes=required.map(criterion=>{
   const c=checks?.find(c=>c.criterion===criterion);
   if(!c)return {criterion,result:'pending',reason:'缺少逐项核验'};
   if(c.result==='failed')return {...c,result:'failed'};
   const refs=c.evidenceIds?.map(id=>evidence?.find(e=>e.id===id))??[];
   const valid=refs.length>0&&refs.every(e=>e&&e.result==='valid'&&e.deliveryVersion===version&&nonempty(e.location)&&nonempty(e.method)&&nonempty(e.reason));
   return {...c,result:c.result==='passed'&&valid?'passed':'pending',reason:valid?c.reason:'证据缺失、未核验、失效或交付版本不适用'};
  });
  return {result:outcomes.some(c=>c.result==='failed')?'failed':outcomes.every(c=>c.result==='passed')?'passed':'pending',items:outcomes};
 }
 for(const s of m.stations){
  const e=latest(s),v=e&&log.reviews.filter(v=>v.receiptId===e.id).at(-1);
  let reason=!e?'尚无归属有效的回执':!v?'尚无独立核验':v.headHash!==headDigest(m,e.receipt)?'方案、站点头或依赖已改变，核验待复核':log.invalidations.some(i=>i.reviewId===v.id)?'核验或证据已失效，待复核':'';
  const check=reason?{result:'pending',reason}:criteria(s.acceptance,v.review.checks,v.review.evidence,e.receipt.deliveryVersion);
  results[s.id]={stationId:s.id,receiptId:e?.id,reviewId:v?.id,acceptance:check,localPassed:check.result==='passed'&&!e.receipt.blockers.length,reason:reason|| (e?.receipt.blockers.length?'有阻塞交付的未决事项':'')};
 }
 function edgeValid(from,to){
  const source=m.stations.find(s=>s.id===from),e=source&&latest(source),v=e&&log.reviews.filter(v=>v.receiptId===e.id).at(-1);
  if(!e||!v)return false;
  return e.receipt.next.every(n=>source.successors.includes(n.stationId))&&source?.successors.includes(to)&&e?.receipt.next.some(n=>n.stationId===to)&&v?.headHash===headDigest(m,e.receipt)&&!log.invalidations.some(i=>i.reviewId===v.id)&&v.review.handoffs.some(h=>h.stationId===to&&h.result==='matched');
 }
 const passedMemo=new Map();
 function passed(id,trail=new Set()){
  if(passedMemo.has(id))return passedMemo.get(id);
  if(trail.has(id))return false;const s=m.stations.find(s=>s.id===id);if(!s||!results[id].localPassed)return false;
  const result=s.dependsOn.every(d=>passed(d,new Set([...trail,id]))&&edgeValid(d,id));passedMemo.set(id,result);return result;
 }
 function terminalChecks(task){
  const candidate=log.reviews.filter(v=>{
   const e=log.receipts.find(e=>e.id===v.receiptId),station=e&&m.stations.find(s=>s.id===e.receipt.stationId);
   return e&&station&&e.receipt.taskId===task.id&&!station.successors.some(id=>m.stations.find(s=>s.id===id)?.taskId===task.id)&&latest(station)?.id===e.id;
  }).at(-1);
  if(!candidate)return false;
  const e=log.receipts.find(e=>e.id===candidate.receiptId);
  return candidate.headHash===headDigest(m,e.receipt)&&!log.invalidations.some(i=>i.reviewId===candidate.id)&&criteria(task.acceptance,candidate.review.taskChecks,candidate.review.evidence,e.receipt.deliveryVersion).result==='passed';
 }
 const taskDone=t=>m.stations.some(s=>s.taskId===t.id)&&m.stations.filter(s=>s.taskId===t.id).every(s=>passed(s.id))&&terminalChecks(t);
 const allTasks=m.tasks.length>0&&m.tasks.every(taskDone);
 for(const s of m.stations){
  const out=results[s.id],e=log.receipts.find(e=>e.id===out.receiptId),v=log.reviews.find(v=>v.id===out.reviewId),decide=(conclusion,reason)=>Object.assign(out,{conclusion,reason});
  out.passed=passed(s.id);out.waiting=s.dependsOn.filter(d=>!passed(d)||!edgeValid(d,s.id));out.handoffs=[];
  if(out.acceptance.result==='failed'||e?.receipt.blockers.length){decide('A',out.reason||'本站验收未通过，继续本站必要修复');continue;}
  if(!out.localPassed){decide('B',out.reason||'本站必要验收证据不足');continue;}
  if(out.waiting.length){decide('C','本站逐项验收通过，但前置依赖未满足');continue;}
  const unexpected=e.receipt.next.filter(n=>!s.successors.includes(n.stationId));
  if(unexpected.length){decide('G','尾部提出了方案之外的后继，需明确处理');continue;}
  for(const id of s.successors){
   const target=m.stations.find(s=>s.id===id),tail=e.receipt.next.find(n=>n.stationId===id),match=v.review.handoffs.find(h=>h.stationId===id),waiting=target.dependsOn.filter(d=>!passed(d)||!edgeValid(d,id));
   out.handoffs.push({stationId:id,head:{goal:target.title,scope:target.scope,acceptance:target.acceptance},tail,match:tail?match?.result??'pending':'pending',reason:match?.reason||'缺少尾部内容或独立语义核验',waiting});
  }
  if(out.handoffs.some(h=>h.match==='mismatch')){decide('G','头尾范围或交付要求不匹配，不解锁后继');continue;}
  if(out.handoffs.some(h=>h.match==='pending')){decide('B','头尾匹配证据不足');continue;}
  const owner=m.tasks.find(t=>t.id===s.taskId);
  if(!s.successors.some(id=>m.stations.find(x=>x.id===id)?.taskId===s.taskId)&&criteria(owner.acceptance,v.review.taskChecks,v.review.evidence,e.receipt.deliveryVersion).result==='failed'){decide('A','任务终点验收未通过，继续本站必要修复');continue;}
  if(!s.successors.some(id=>m.stations.find(x=>x.id===id)?.taskId===s.taskId)&&taskDone(owner)){
   const projectPassed=allTasks&&criteria(projectCriteria,v.review.projectChecks,v.review.evidence,e.receipt.deliveryVersion).result==='passed';
   decide(projectPassed?'F':'E',projectPassed?'项目全部预设条件通过（关闭执行属于 M04）':`本任务线交付通过；交接对象：${owner.handoff||'无'}，下游依赖与项目条件另行核对`);continue;
  }
  if(out.handoffs.some(h=>h.waiting.length)){decide('C','后继尚有其他必要依赖未满足');continue;}
  if(s.successors.length){decide('D','本站与全部后继交接通过；可开始不代表已经开始');continue;}
  const task=m.tasks.find(t=>t.id===s.taskId);
  if(criteria(task.acceptance,v.review.taskChecks,v.review.evidence,e.receipt.deliveryVersion).result==='failed'){decide('A','任务终点验收未通过，继续本站必要修复');continue;}
  if(!taskDone(task)){decide('B','终点还需任务全部站点及终点条件的有效证据');continue;}
  const projectPassed=allTasks&&criteria(projectCriteria,v.review.projectChecks,v.review.evidence,e.receipt.deliveryVersion).result==='passed';
  decide(projectPassed?'F':'E',projectPassed?'项目全部预设条件通过（关闭执行属于 M04）':`本任务线交付通过；交接对象：${task.handoff||'无'}，项目完成条件另行核对`);
 }
 return {ruleVersion:'m03-v1',results,log,quarantined:log.receipts.filter(e=>identity(projectId,m,e.receipt)).map(e=>({id:e.id,reason:identity(projectId,m,e.receipt)}))};
}
