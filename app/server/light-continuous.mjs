// 日期：2026-11-13。按已登记阶段驱动公开 Codex 会话；完成依据仍来自领域服务。
import {randomUUID,createHash} from 'node:crypto';
import {readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {CodexSessionClient} from './codex-session-client.mjs';
import {inspectWorkspace} from '../../plugins/task-workbench/skills/workbench-handoff/scripts/context-ledger.mjs';
import {stepPassed,waitingFor,planProgress,lightError} from './light-model.mjs';
import {digest} from './receipts.mjs';

const activeStates=new Set(['running','pausing']);
const stamp=()=>new Date().toISOString();
export function validateContinuous(value){
  if(value===undefined)return;
  if(value?.version!==1||!Array.isArray(value.runs)||value.runs.some(r=>!r.id||!r.planKey||!['running','pausing','paused','blocked','completed'].includes(r.status)||!Array.isArray(r.history)))throw Error('INVALID_CONTINUOUS_STATE');
}
export function createContinuousRunner(persistence,service,{clientFactory=()=>new CodexSessionClient(),principalProvider}={}){
  const clients=new Map(),pumps=new Set(),workspaceClaims=new Map();let closed=false;
  const state=()=>persistence.read('lightContinuous')??{version:1,runs:[]};
  const snapshot=()=>persistence.read('light')?.snapshot;
  const find=id=>state().runs.find(r=>r.id===id);
  async function update(id,fields){if(closed)return;await persistence.run(()=>{const s=state(),r=s.runs.find(r=>r.id===id);if(r){Object.assign(r,fields,{updatedAt:stamp()});persistence.write('lightContinuous',s);}});}
  function summary(run){const s=snapshot(),stages=s?.steps.filter(x=>x.planKey===run.planKey&&x.parentKey===null&&x.required)??[];return {id:run.id,planKey:run.planKey,status:run.status,stageCode:run.current?.code??null,threadId:run.current?.threadId??null,reason:run.reason??'',completed:stages.filter(x=>stepPassed(s,x)).length,total:stages.length};}
  async function principal(){
    if(principalProvider)return principalProvider();
    const config=JSON.parse(await readFile(path.join(process.env.CODEX_HOME??path.join(os.homedir(),'.codex'),'task-workbench-light/config.json'),'utf8'));
    const grant=Object.entries(persistence.read('grants')).find(([,g])=>g.kind==='lightAccess'&&g.automatic&&!g.revokedAt&&(g.appId??'codex')==='codex'&&g.tokenHash===digest(config.token));
    if(!grant)throw Error('CODEX_NOT_CONNECTED');return grant[0];
  }
  const base=(run,eventId)=>{const s=snapshot(),p=s.plans.find(p=>p.key===run.planKey),project=s.projects.find(x=>x.key===p.projectKey);const {trust,...source}=p.source;return {schemaVersion:'light-1.0',projectId:project.id,planId:p.id,expectedRevision:project.revision,eventId:run.id+'/'+eventId,source,occurredAt:stamp(),reason:'用户开启按阶段连续执行'};};
  async function verifySource(plan){const bytes=await readFile(plan.source.path);if(createHash('sha256').update(bytes).digest('hex')!==plan.source.sha256)throw Error('SOURCE_CHANGED');}
  async function prepare(run,step,client){
    const s=snapshot(),plan=s.plans.find(p=>p.key===run.planKey);
    await verifySource(plan);
    if(find(run.id).status!=='running')return null;
    const route=s.routes.find(r=>r.planKey===plan.key&&r.stepKeys.includes(step.key));
    if(!route)throw Error('STAGE_ROUTE_REQUIRED');
    const cwd=await realpath(route.context.worktreePath),observed=await inspectWorkspace(cwd);
    if(observed.branch!==route.context.branch)throw Error('WORKSPACE_BRANCH_CHANGED');
    const cwdKey=cwd.toLowerCase();
    if(workspaceClaims.has(cwdKey)&&workspaceClaims.get(cwdKey)!==run.id)throw Error('WORKSPACE_BUSY');
    workspaceClaims.set(cwdKey,run.id);
    // 同目录只启动一条执行线，已有执行需先完成或接手原会话。
    if(s.executions.some(e=>!e.endedAt&&s.bindings.some(b=>b.key===e.bindingKey&&path.resolve(b.context.worktreePath).toLowerCase()===cwd.toLowerCase())))throw Error('WORKSPACE_BUSY');
    const current={stepId:step.id,stepKey:step.key,code:step.code,threadId:null,creationAttempted:true,turnId:null};
    await update(run.id,{current});
    const thread=await client.create(cwd,`${plan.name} / ${step.code}：${step.title}`);
    current.threadId=thread.id;await update(run.id,{current});
    const owner=await principal();
    const context={...route.context,threadId:thread.id,hostId:'local',worktreePath:cwd,branch:observed.branch,head:observed.head,trust:'declared'};
    const scope=s.steps.filter(x=>x.key===step.key||x.parentKey===step.key);
    const previous=s.bindings.filter(b=>b.state==='confirmed'&&b.planKey===plan.key&&b.stepKeys.some(key=>scope.some(x=>x.key===key||x.parentKey===key)));
    if(previous.length>1)throw Error('MULTIPLE_BINDINGS_REQUIRE_REVIEW');
    const old=previous[0];
    const stepIds=old?old.stepKeys.map(key=>s.steps.find(x=>x.key===key)?.id):[step.id];
    const takeover=old?{fromBindingId:old.id,expectedBindingRevision:old.bindingRevision,executionIds:[]}:undefined;
    const proposal={...base(run,step.code+'/bind'),action:'propose',stepIds,context,bindingId:null,expectedBindingRevision:null,confirmationGrant:null,...(takeover?{takeover}:{})};
    let bound=await service.bind(owner,proposal);
    if(bound.state!=='confirmed')bound=await service.bind(owner,{...proposal,...base(run,step.code+'/confirm'),action:'confirm',bindingId:bound.bindingId,expectedBindingRevision:bound.bindingRevision});
    if(bound.state!=='confirmed')throw Error('BINDING_NOT_CONFIRMED');
    current.bindingId=bound.bindingId;current.bindingRevision=bound.bindingRevision;
    const reserved=await service.reserveExecutionId(owner,base(run,step.code+'/reserve'));current.executionId=reserved.executionId;
    await update(run.id,{current});
    await service.update(owner,{...base(run,step.code+'/start'),stepId:step.id,executionId:current.executionId,bindingId:current.bindingId,bindingRevision:current.bindingRevision,
      targetStatus:'running',evidence:[],checks:[],blocker:null,reopen:null,successorImpact:null});
    return current;
  }
  function prompt(run,current){
    const s=snapshot(),plan=s.plans.find(p=>p.key===run.planKey),stage=s.steps.find(x=>x.key===current.stepKey),scope=s.steps.filter(x=>x.key===stage.key||x.parentKey===stage.key);
    return `开始执行 ${plan.name} / ${stage.code}：${stage.title}\n日期：${new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date())}\n用户已在任务岛点击“连续执行”，授权在该方案既定范围内按阶段创建会话、执行、同步进度及接续直至整体结束。你只负责本阶段及其子步骤，结束后由任务岛调度下一阶段，不自行创建聊天。\n读取当前安装的 workbench-handoff 技能和方案原文：${plan.source.path}。核对适用AGENTS.md。不要重新登记方案。实际任务执行与验收必须按原文，不凭预设或自述标记通过。若方案明确为空任务模拟，按原文等待及返回值执行。\n真实会话ID：${current.threadId}；宿主local。总控已完成此会话的绑定及本阶段running登记。复用以下身份，不重复预留本阶段executionId，不接手别的责任。每次状态写入前回读最新版本。\n${JSON.stringify({projectId:s.projects.find(p=>p.key===plan.projectKey).id,planId:plan.id,bindingId:current.bindingId,bindingRevision:current.bindingRevision,executionId:current.executionId,stageId:current.stepId,scope:scope.map(x=>({id:x.id,code:x.code,parentKey:x.parentKey,dependsOn:x.dependsOn,conditions:x.conditions,status:x.status}))},null,2)}\n使用工作台MCP回读并按实际结果同步。子步骤依次取得各自开始许可和executionId，沿用本阶段父级责任绑定覆盖子步骤；全部必要子步骤完成验收后，完成本阶段。保留可回读的实际证据。提交completed前逐项匹配服务中的conditionId、text、required，result=passed并关联passed证据。参数被明确拒绝时按validationErrors修正后继续。\n已授权且仍有必要修复时继续本阶段；真正外部阻塞、失败或需人工决定时如实标记blocked并报告原因。禁止越过前置或把会话结束当成阶段成功。`;
  }
  async function pump(id){
    if(pumps.has(id)||closed)return;pumps.add(id);
    const client=clientFactory();clients.set(id,client);
    try{
      while(!closed){
        let run=find(id);if(!run||!activeStates.has(run.status))return;
        if(run.status==='pausing'){await update(id,{status:'paused',reason:'已暂停接续'});return;}
        const s=snapshot(),plan=s?.plans.find(p=>p.key===run.planKey);if(!plan)throw Error('PLAN_NOT_FOUND');
        if(plan.source.sha256!==run.sourceHash)throw Error('SOURCE_CHANGED');
        await verifySource(plan);
        const stages=s.steps.filter(x=>x.planKey===plan.key&&x.parentKey===null&&x.required).sort((a,b)=>a.order-b.order);
        let current=run.current;
        if(current?.adopted){
          const step=s.steps.find(x=>x.key===current.stepKey);
          if(step&&stepPassed(s,step)){await update(id,{current:null});continue;}
          if(step?.status!=='running')throw Error('原执行阶段需要处理阻塞后继续');
          await client.connect?.();
          if(client.request){const response=await client.request('thread/read',{threadId:current.threadId,includeTurns:true});const last=response.thread?.turns?.at(-1);if(last&&last.status!=='inProgress')throw Error('原阶段会话已结束但尚未通过验收，请修复后继续');}
          await new Promise(resolve=>setTimeout(resolve,1000));continue;
        }else if(current){
          if(!current.threadId)throw Error('THREAD_CREATION_RESULT_UNKNOWN');
          const step=s.steps.find(x=>x.key===current.stepKey);
          if(step&&stepPassed(s,step)){await update(id,{current:null});continue;}
          if(!current.executionId)throw Error('INCOMPLETE_START_REQUIRES_REVIEW');
          await client.resume(current.threadId);
        }else{
          const pending=stages.filter(x=>!stepPassed(s,x));
          if(!pending.length){
            if(plan.endConditions.some(c=>c.required&&c.result!=='passed')){
              const last=run.history.at(-1);if(!last?.threadId)throw Error('方案结束条件尚未验收');
              await client.resume(last.threadId);
              const finalTurn=await client.run(last.threadId,`日期：${stamp()}\n所有阶段已通过，用户授权连续执行到整体结束。请回读方案${plan.id}和原文${plan.source.path}，逐项实际核验方案endConditions；不要把阶段通过等同于最终批准。按真实证据调用workbench_complete_plan并回读。如需人工决定则明确报告，不自动代签。复用原项目${base(run,'final').projectId}，不要重新登记。`);
              if(finalTurn.status!=='completed')throw Error('方案最终验收会话未完成');
              const latest=snapshot().plans.find(p=>p.key===plan.key);if(latest.endConditions.some(c=>c.required&&c.result!=='passed'))throw Error('方案结束条件尚未通过，请处理最终验收后继续');
            }
            const fresh=snapshot(),finalPlan=fresh.plans.find(p=>p.key===plan.key),last=stages.at(-1);
            const proofIds=new Set(finalPlan.endConditions.flatMap(c=>c.evidenceIds));
            const proofs=proofIds.size?[...new Map(fresh.steps.filter(x=>x.planKey===plan.key).flatMap(x=>x.evidence).filter(e=>proofIds.has(e.evidenceId)).map(e=>[e.evidenceId,e])).values()]:fresh.steps.find(x=>x.key===last?.key)?.evidence??[];
            const owner=await principal(),input=base(run,'complete-plan');
            if(service.query(owner,input.projectId,'completePlan',input.eventId).state!=='committed')await service.completePlan(owner,{...input,checks:finalPlan.endConditions,evidence:proofs});
            if(!planProgress(snapshot(),plan.key).passed)throw Error('方案最终状态仍未通过验收');
            await update(id,{status:'completed',current:null,reason:'整个方案已完成并通过验收'});return;
          }
          const ongoing=pending.find(x=>x.status==='running');
          if(ongoing){const binding=s.bindings.find(b=>b.key===ongoing.bindingKey);if(!binding?.context.threadId)throw Error('现有执行缺少真实会话身份');await update(id,{current:{adopted:true,stepId:ongoing.id,stepKey:ongoing.key,code:ongoing.code,threadId:binding.context.threadId}});continue;}
          const step=pending.find(x=>x.status==='pending'&&!waitingFor(s,x).length&&!x.blockers.some(b=>!b.resolved));
          if(!step)throw Error('阶段存在阻塞、取消、未结束执行或未满足前置，需先处理后继续');
          current=await prepare(run,step,client);if(!current){await update(id,{status:'paused',reason:'已暂停接续'});return;}run=find(id);
        }
        const turn=await client.run(current.threadId,prompt(run,current),async turnId=>{current={...current,turnId};await update(id,{current});});
        if(closed)return;
        const latest=snapshot(),step=latest.steps.find(x=>x.key===current.stepKey);
        const after=find(id);
        const history=[...after.history,{stepKey:current.stepKey,threadId:current.threadId,turnId:current.turnId,turnStatus:turn.status,at:stamp()}];
        await update(id,{history});
        if(turn.status!=='completed'||client.interactionRequired)throw Error(client.interactionRequired?'需要人工确认，请处理该阶段会话后继续':'阶段会话失败或被中断');
        if(!stepPassed(latest,step))throw Error('阶段会话已结束，但工作台验收未通过；请在该会话修复后继续');
        await update(id,{current:null});
        if(find(id).status==='pausing'){await update(id,{status:'paused',reason:'当前阶段已完成，后续阶段已暂停'});return;}
      }
    }catch(error){if(!closed)await update(id,{status:'blocked',reason:String(error.message).slice(0,600)});}
    finally{client.close();clients.delete(id);pumps.delete(id);for(const [cwd,owner]of workspaceClaims)if(owner===id)workspaceClaims.delete(cwd);}
  }
  return {
    async initialize(){await persistence.run(()=>{const s=state();for(const r of s.runs)if(activeStates.has(r.status)){r.status='paused';r.reason='服务已重启，请点击继续，复用原阶段会话核验恢复';}persistence.write('lightContinuous',s);});},
    read(){return state().runs.map(summary);},
    async change(input){
      if(!input||Object.keys(input).some(k=>!['planKey','action','expectedRevision','acknowledged'].includes(k))||input.acknowledged!==true||!['start','pause','resume'].includes(input.action)||typeof input.planKey!=='string')lightError('INVALID_INPUT','连续执行请求无效');
      let run;
      await persistence.run(async()=>{
        const snap=snapshot(),plan=snap?.plans.find(p=>p.key===input.planKey),project=snap?.projects.find(p=>p.key===plan?.projectKey);
        if(!plan||!project)lightError('NOT_FOUND','方案不存在');
        if(project.revision!==input.expectedRevision)lightError('REVISION_CONFLICT','任务已更新，请刷新重试',409);
        const s=state();run=s.runs.find(r=>r.planKey===plan.key);
        if(input.action==='pause'){if(run&&activeStates.has(run.status)){run.status=pumps.has(run.id)?'pausing':'paused';run.reason='当前阶段完成后暂停，不再新建后续会话';}}
        else{
          await principal();await verifySource(plan);
          if(!run){run={id:randomUUID(),planKey:plan.key,sourceHash:plan.source.sha256,status:'running',current:null,history:[],createdAt:stamp(),updatedAt:stamp(),reason:''};s.runs.push(run);}
          else if(!activeStates.has(run.status)&&run.status!=='completed'){run.status='running';run.reason='';}
        }
        persistence.write('lightContinuous',s);
      });
      if(run?.status==='running')setTimeout(()=>void pump(run.id),0);
      return {saved:true,run:run?summary(run):null};
    },
    close(){closed=true;for(const c of clients.values())c.close();},
  };
}
