import {readFile} from 'node:fs/promises';
import {digest} from './receipts.mjs';
import {comparePlans} from './plan-diff.mjs';
import {HttpError} from './validation.mjs';
import {stepSummary,stepCircle} from './plan-steps.mjs';

const TEMPLATE_URL=new URL('../../docs/01_任务监测工作台_v1.0/02_任务收敛与交接指令_原文_2026-11-08.md',import.meta.url);
const known=v=>typeof v==='string'&&v.trim()?v:'待核实';
const lines=v=>v?.length?v.join('；'):'待核实：方案未登记';
const dateInShanghai=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
const conclusions={A:'继续本站',B:'等待核验',C:'等待依赖',D:'可进入下一站',E:'本任务线结束',F:'项目结束',G:'方案变更待确认'};
export async function loadOutputTemplate(){
 const archive=await readFile(TEMPLATE_URL,'utf8');
 const general=archive.split('## 通用模板')[1]?.split('## 原文归档')[0]?.match(/```text\r?\n([\s\S]*?)```/)?.[1]?.replace(/\r\n/g,'\n');
 const fields=general?.split('【执行完成后必须返回的回执】')[1]?.split(/\r?\n/).filter(l=>l.startsWith('- ')).map(l=>l.slice(2).split('：')[0]);
 if(!general||fields?.length!==18)throw new Error('通用模板回执字段缺失，停止生成');
 return {general,fields,hash:digest(general),path:TEMPLATE_URL.pathname};
}

export function generateOutput(project,view,body,template){
 const m=view.model,s=m.stations.find(s=>s.id===body.stationId);
 if(!s)throw new HttpError(400,m.stations.length?'请选择当前项目中的站点':'当前项目尚未登记站点，请先在管理任务与方案版本中保存关系');
 const r=view.inspection.results[s.id],task=m.tasks.find(t=>t.id===s.taskId),taskState=view.tasks.find(t=>t.id===s.taskId);
 const plan=m.plans.find(p=>p.id===s.planId),diff=comparePlans(m,view),date=dateInShanghai();
 const entry=view.inspection.log.receipts.find(e=>e.id===r.receiptId),review=view.inspection.log.reviews.find(v=>v.id===r.reviewId);
 let conclusion=r.conclusion,reason=r.reason;
 if(conclusion==='F'&&view.project.status!=='closed') {conclusion=taskState.status==='closed'?'E':'B';reason='项目当前未有效关闭；'+view.project.reason;}
 if(conclusion==='E'&&taskState.status!=='closed'){conclusion='B';reason='任务当前未有效关闭；'+taskState.reason;}
 if(taskState.status==='recheck'&&['E','F'].includes(conclusion)){conclusion='B';reason='历史关闭仍保留，当前证据或条件待复核';}
 const canSelectEdge=r.passed&&['C','D'].includes(conclusion);
 if(body.successorId){
  const h=r.handoffs.find(h=>h.stationId===body.successorId);
  if(!canSelectEdge||!h)throw new HttpError(400,'当前判断不允许选择该后继交接边');
  conclusion=h.match==='mismatch'?'G':h.match!=='matched'?'B':h.waiting.length?'C':'D';
  reason=`对应后继 ${m.stations.find(s=>s.id===h.stationId).code}：${h.reason}；${h.waiting.length?'等待全部前置有效通过':'对应交接及全部前置通过，可开始不代表已开始'}`;
 }
 const warnings=[];
 const name=id=>{const x=m.stations.find(s=>s.id===id);return x?`${x.code} ${x.title}（${id}）`:id;};
 const planRef=p=>p?`${known(p.sourcePath)}；版本 ${known(p.version)}；日期 ${known(p.date)}；章节 ${known(p.chapter)}`:'待核实：未绑定方案';
 // A bound model can be only a subset of the plan. Its size is not proof of
 // the plan's total step count, even when every saved station has a plan ID.
 const stepOverview=stepSummary(plan,m.stations);
 function context(target){
  const t=m.tasks.find(t=>t.id===target.taskId),folder=m.folders.find(f=>f.id===t.folderId),p=m.plans.find(p=>p.id===target.planId);
  const candidates=m.chats.filter(c=>c.taskId===t.id&&c.folderId===t.folderId);
  const source=candidates.find(c=>c.id===body.sourceId)??(!body.sourceId?candidates.find(c=>c.id===entry?.receipt.sourceId)??(candidates.length===1?candidates[0]:null):null);
  const missing=[];
  for(const [key,v] of [['项目名称',project.name],['所属文件夹名称',folder?.name],['Codex 项目标识',folder?.externalId],['任务目标',t.goal],['仓库',source?.repository],['工作树',source?.worktree],['分支',source?.branch],['HEAD',source?.head],['聊天来源',source?.id],['来源记录时间',source?.time],['方案路径',p?.sourcePath],['方案版本',p?.version],['方案日期',p?.date],['方案章节',target.chapter||p?.chapter],['方案原文',p?.source],['站点范围',target.scope]])if(typeof v!=='string'||!v.trim())missing.push(key);
  if(target.planId!==m.currentPlanId)missing.push('站点并未绑定当前方案');
  if(!target.acceptance?.length)missing.push('站点验收条件');
  warnings.push(...missing.map(k=>`${target.code} ${k}待核实；执行前补齐，不猜测或投递`));
  return {t,folder,p,source,text:`开发项目：${known(project.name)}（本地项目 ID：${project.id}）\n所属 Codex 项目文件夹：${known(folder?.name)}；项目标识：${known(folder?.externalId)}；本地文件夹 ID：${known(folder?.id)}\n任务线：${known(t.name)}（${t.id}）；任务最终目标：${known(t.goal)}\n仓库：${known(source?.repository)}\n工作树：${known(source?.worktree)}\nGit 分支快照：${known(source?.branch)}；HEAD 快照：${known(source?.head)}\n来源：${known(source?.externalId)}（${known(source?.id)}）；记录时间：${known(source?.time)}；位置：${known(source?.location)}\n方案文档：${planRef(p)}；站点章节：${known(target.chapter||p?.chapter)}\n以上为登记快照，执行前重新检查适用 AGENTS.md、Git 状态、分支、HEAD、工作树、并行改动、方案原文及当前证据；现场事实优先。身份或出处缺失时先核实，禁止猜测或错误投递。`};
 }
 const ctx=context(s);
 const evidenceText=JSON.stringify({deliveryVersion:entry?.receipt.deliveryVersion??'待核实',receiptId:r.receiptId??'无',reviewId:r.reviewId??'无',acceptance:r.acceptance,evidence:review?.review.evidence??[],blockers:entry?.receipt.blockers??[],effectiveReason:r.reason,invalidations:view.inspection.log.invalidations.filter(i=>i.reviewId===r.reviewId)},null,2);
 const dependencies=target=>target.dependsOn.length?target.dependsOn.map(id=>{const d=view.inspection.results[id],h=d?.handoffs.find(h=>h.stationId===target.id);return `${name(id)}：有效验收 ${d?.passed?'通过':'未通过或待核验'}，对应交接边 ${h?.match||'待核验'}；回执 ${d?.receiptId||'无'}，核验 ${d?.reviewId||'无'}`;}).join('\n'):'无前置站点（以绑定方案为准）';
 function receipt(target,actual=false,c=conclusion){
  const t=m.tasks.find(t=>t.id===target.taskId);
  const values={
   日期:date,
   方案文档为:planRef(m.plans.find(p=>p.id===target.planId)),
   本方案一共为:stepSummary(m.plans.find(p=>p.id===target.planId),m.stations),
   本次执行步骤为:`${target.code}，${target.title}`,
   本步骤是否完成:actual?(r.localPassed?'是':'待核验'):'待核验；执行后按逐项证据填写',
   是否满足方案预期:actual?(r.passed?'满足本站当前方案；项目和初始符合性另列':'待核验'):'待核验；执行后按实际验收填写',
   '任务线 / 步骤编号':`${known(t.name)} / ${target.code}`,
   本站原定目标:target.scope||target.title,
   实际交付:actual?known(entry?.receipt.actual):'执行后据实填写交付与版本',
   提交及验证证据:actual?evidenceText:'执行后记录精确提交、检查方法、输入、预期、实际、适用版本和证据位置',
   各项验收条件及结果:actual?JSON.stringify(r.acceptance):`${lines(target.acceptance)}；逐项据实填写通过 / 未通过 / 待核验`,
   当前阻塞:actual?(['E','F'].includes(c)?'无':reason):'执行后据实列出等待对象、条件与恢复条件',
   任务线是否已到终点:actual?(taskState.status==='closed'?'是':'否或待核验'):'执行后按方案终点核验',
   下一站:actual?(['E','F'].includes(c)?'无（本任务已有效关闭）':lines(target.successors.map(name))):`${lines(target.successors.map(name))}；仅报告交接，不自动执行`,
   '本站尾部与下一站头部是否匹配':actual?(['E','F'].includes(c)?'不适用':branches.length?branches.map(b=>`${b.station}：${{matched:'匹配',mismatch:'不匹配',pending:'待核验'}[b.match]||'待核验'}`).join('；'):'待核验'):'执行后逐边填写：匹配 / 不匹配 / 待核验 / 不适用',
   下一站全部前置条件是否满足:actual?(['E','F'].includes(c)?'不适用；交接对象自行核对下游全部前置':reason):'执行后核对每条合法后继的全部前置',
   交接对象:known(t.handoff),
   结束结论:actual?conclusions[c]:'执行后据实选择：继续本站 / 等待核验 / 等待依赖 / 可进入下一站 / 本任务线结束 / 项目结束 / 方案变更待确认'
  };
  return template.fields.map(f=>`- ${f}：${values[f]??'待核实'}`).join('\n');
 }
 const branches=(r.handoffs??[]).map(h=>({stationId:h.stationId,station:name(h.stationId),match:h.match,tail:h.tail??null,head:h.head,waiting:h.waiting.map(name),reason:h.reason,status:h.match==='mismatch'?'G':h.match!=='matched'?'B':h.waiting.length?'C':'D'}));
 const actionTargets=conclusion==='D'?branches.filter(h=>h.status==='D'&&(!body.successorId||body.successorId===h.stationId)).map(h=>m.stations.find(s=>s.id===h.stationId)):['A','B'].includes(conclusion)?[s]:[];
 const instructions=actionTargets.map(target=>{
  const c=context(target),mode=conclusion==='D'?'进入合法下一站':conclusion==='A'?'继续本站必要修复':'补齐本站必要核验';
  const items=r.acceptance.items??[];
  const limited=conclusion==='D'?target.acceptance:items.filter(i=>conclusion==='A'?i.result==='failed':i.result!=='passed').map(i=>i.criterion);
  const work=conclusion==='D'?`按方案目标和范围完成：${known(target.scope)}；交付全部验收项要求的结果：${lines(target.acceptance)}`:conclusion==='A'?`仅修复原验收失败项：${lines(limited)}；必要交付阻塞：${lines(entry?.receipt.blockers)}。若失败属于终点条件，逐项对照任务验收：${lines(task.acceptance)}。未明确的失败原因先核实，禁止增加优化或新站点。`:`仅补齐缺失证据或复核：${lines(limited)}；核验原因：${reason}。本站已通过且未受影响的检查不重复；终点或交接待核验时只补必要任务终点与逐边匹配证据。`;
  return {stationId:target.id,kind:'execution',text:`日期：${date}\n状态：可复制，尚未发送；${mode}\n\n1. 任务名称\n${stepCircle(c.p,target.code)} ${known(c.t.name)} / ${target.code}：${target.title}；${mode}\n\n2. 执行环境\n${c.text}\n\n3. 方案依据\n${planRef(c.p)}\n本方案一共为：${stepSummary(c.p,m.stations)}\n先读取方案原文及其引用的权威资料，核实当前步骤和范围。\n\n4. 本站目标\n${target.title}\n${known(target.scope)}\n任务原始目标：${known(c.t.initialGoal)}\n项目初始目标：${known(diff.initial?.goal)}\n\n5. 范围边界\n仅完成 ${target.code} 的既定目标、验收及交付；不新增主路线、不降低标准、不自行批准方案变更，不接入自动采集、注入或自动执行。\n\n6. 全部前置条件\n${dependencies(target)}\n当前有效判断：${reason}\n上游实际交付和证据：\n${evidenceText}\n可开始不表示已经开始；执行前重新核对全部依赖及其适用版本。\n\n7. 必要执行步骤\n${work}\n优先复用已有实现；如缺身份、方案出处、证据或依赖，先报告缺失及恢复条件，不越过前置。\n\n8. 逐项验收\n${target.acceptance?.map((a,i)=>`${i+1}、${a}：检查实际交付是否满足原文条件；记录输入场景、检查方法、预期要求、实际结果、适用版本、证据位置及限制；不能只凭提交或完成自述判通过。`).join('\n')||'待核实：方案未登记验收条件，补齐前停止执行'}\n任务终点条件：${lines(c.t.acceptance)}\n\n9. Git 提交\n按可验证阶段提交。提交前检查 diff 与暂存区，仅包含本站相关变更，不纳入真实运行数据、密钥、测试产物或他人改动；需要新分支时使用 codex/ 前缀。使用 Conventional Commits，summary 使用简体中文，不超过 72 字符且无句号结尾。同步必要生产构建。\n\n10. 停止条件\n本站原验收条件全部满足后停止扩展；证据不足、依赖缺失或方案冲突时准确报告等待对象、差异与恢复条件，不自行改变范围或验收要求。完成本指令后仅报告交接状态，不自动执行下一站。\n\n11. 执行完成后必须返回的回执\n${receipt(target)}\n`};
 });
 const waitIds=[...new Set([...(r.waiting??[]),...(r.handoffs??[]).flatMap(h=>h.waiting)])];
 const issues={C:`等待对象：${lines(waitIds.map(name))}。等待条件：上述依赖的必要验收及对应交接边有效通过。恢复条件：证据有效且全部前置重新核验通过后再生成合法后继指令。`,E:`交接对象：${known(task.handoff)}。本任务已交付；下游按自身方案和全部依赖接手，不将其工作追加到本任务。\n本任务无下一步执行指令，到此结束`,F:'项目有效关闭且全部最终条件适用，历史关闭证据仍保留。\n本任务无下一步执行指令，到此结束',G:`方案冲突：${reason}\n范围差异：${JSON.stringify(branches)}；方案对照：${diff.impact}\n待决定事项：明确是否修正回执或另行审批方案变更；保留初始目标、原文和历史，不自行批准或应用。恢复条件：处理决定明确，方案及证据重新核验通过。`};
 const report=instructions.length?null:{kind:'receipt',text:`日期：${date}\n状态：${conclusions[conclusion]}\n${ctx.text}\n\n${receipt(s,true)}\n\n${issues[conclusion]??reason}\n逐边交接：${JSON.stringify(branches)}\n历史状态：任务 ${taskState.status}；项目 ${view.project.status}。历史关闭不替代当前核验。`};
 const replacements={'完整路径':known(plan?.sourcePath),'完整路径；没有则写无':'待核实：读取方案原文引用的权威资料，不猜测其他文件路径','项目名称，未知写待核实':`${known(project.name)}（${project.id}）`,'文件夹名称或标识，未知写待核实':`${known(ctx.folder?.name)}（${known(ctx.folder?.externalId)}）`,'名称、编号；未知写待核实':`${known(task.name)} / ${s.code} ${s.title}`,'已知信息；未知写待核实，执行前重新核对':`${known(ctx.source?.repository)} / ${known(ctx.source?.worktree)} / ${known(ctx.source?.branch)}；HEAD ${known(ctx.source?.head)}`};
 const audit={kind:'audit',text:`日期：${date}\n状态：核对提示词，仅核对和生成，不执行开发\n${ctx.text}\n\n${template.general.replace(/【需填写：([^】]+)】/g,(_,k)=>replacements[k]??'待核实').replace(/^- 本方案一共为：[\s\S]*?(?=^- 本次执行步骤为：)/m,`- 本方案一共为：${stepOverview}\n`)}`};
 const fingerprint=digest({project,model:m,revision:view.revision,stationId:s.id,sourceId:body.sourceId??'',successorId:body.successorId??'',date,template:template.hash});
 if(body.expectedFingerprint&&body.expectedFingerprint!==fingerprint)throw new HttpError(409,'状态或方案已变化，请重新生成并核对预览后复制');
 return {projectId:project.id,stationId:s.id,revision:view.revision,fingerprint,date,conclusion,reason,warnings:[...new Set(warnings)],audit,instructions,report,branches,diff,canSelectEdge,
  choices:m.stations.map(x=>({id:x.id,label:`${m.tasks.find(t=>t.id===x.taskId)?.name||x.taskId} / ${x.code} ${x.title}`})),sources:m.chats.map(c=>({id:c.id,label:`${c.externalId||c.id} / ${m.tasks.find(t=>t.id===c.taskId)?.name||c.taskId}`}))};
}
