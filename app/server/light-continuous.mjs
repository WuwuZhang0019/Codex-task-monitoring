// 日期：2026-11-13。按已登记阶段驱动公开 Codex 会话；完成依据仍来自领域服务。
import {randomUUID,createHash} from 'node:crypto';
import {readFile,realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createSessionClient} from './codex-session-client.mjs';
import {inspectWorkspace} from '../../plugins/task-workbench/skills/workbench-handoff/scripts/context-ledger.mjs';
import {stepPassed,waitingFor,planProgress,lightError} from './light-model.mjs';
import {digest} from './receipts.mjs';

const activeStates=new Set(['running','pausing']);
const modes=new Set(['stages','current_thread']);
const stamp=()=>new Date().toISOString();
const samePath=(a,b)=>process.platform==='win32'?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b);
const enabled=run=>run.enabled??['running','blocked'].includes(run.status);
function failureReason(error){
  const messages={CODEX_DESKTOP_BRIDGE_UNAVAILABLE:'当前后台未获得 Codex 桌面的会话控制连接；请从 Codex 启动任务岛后重试，或使用按阶段接续',CODEX_EXTERNAL_THREAD_REQUIRES_DESKTOP:'原会话需要通过 Codex 桌面连接，不能另起执行器接管',CODEX_ACTIVE_TURN_UNKNOWN:'无法确认原会话当前状态，请先核对该会话后重试',CODEX_THREAD_CONTEXT_MISMATCH:'原会话身份或目录与登记不一致，请先核对绑定',CODEX_THREAD_BUSY:'当前会话仍在执行，等待其结束后再接续',CODEX_INTERACTION_REQUIRED:'当前会话正在等待人工批准或输入，请处理后重试',CODEX_DELIVERY_UNKNOWN:'指令投递结果未知，请先核对原会话，避免重复发送',CODEX_DELIVERY_REJECTED:'原会话拒绝了连续执行指令，请处理该会话后重试',CODEX_UNAVAILABLE:'Codex 执行器不可用，请检查安装与登录状态',CODEX_DISCONNECTED:'Codex 执行器连接中断，请核对原会话后重试'};
  return (messages[error.code]??error.message??String(error)).slice(0,600);
}
export function validateContinuous(value){
  if(value===undefined)return;
  if(value?.version!==1||!Array.isArray(value.runs)||value.runs.some(r=>!r.id||!r.planKey||!['running','pausing','paused','blocked','completed'].includes(r.status)||!Array.isArray(r.history)||(r.mode!==undefined&&!modes.has(r.mode))||(r.enabled!==undefined&&typeof r.enabled!=='boolean')))throw Error('INVALID_CONTINUOUS_STATE');
}
export function createContinuousRunner(persistence,service,{clientFactory=createSessionClient,principalProvider}={}){
  const clients=new Map(),pumps=new Set(),workspaceClaims=new Map(),notifications=new Map();let closed=false;
  const state=()=>persistence.read('lightContinuous')??{version:1,runs:[]};
  const snapshot=()=>persistence.read('light')?.snapshot;
  const find=id=>state().runs.find(r=>r.id===id);
  async function update(id,fields){if(closed)return;await persistence.run(()=>{const s=state(),r=s.runs.find(r=>r.id===id);if(r){Object.assign(r,fields,{updatedAt:stamp()});persistence.write('lightContinuous',s);}});}
  async function pauseIfRequested(id,reason){if(closed)return;await persistence.run(()=>{const s=state(),r=s.runs.find(r=>r.id===id);if(r?.status==='pausing'){Object.assign(r,{status:'paused',enabled:false,phase:null,reason,updatedAt:stamp()});persistence.write('lightContinuous',s);}});}
  function summary(run){const s=snapshot(),stages=s?.steps.filter(x=>x.planKey===run.planKey&&x.parentKey===null&&x.required)??[];return {id:run.id,planKey:run.planKey,status:run.status,mode:run.mode??'stages',enabled:run.status==='completed'?false:enabled(run),phase:run.phase??null,stageCode:run.current?.code??null,threadId:run.current?.threadId??run.session?.threadId??null,reason:run.reason??'',completed:stages.filter(x=>stepPassed(s,x)).length,total:stages.length};}
  const completedRun=plan=>({id:'completed/'+plan.key,planKey:plan.key,status:'completed',mode:'stages',enabled:false,history:[],reason:'整个方案已完成并通过验收'});
  async function principal(){
    if(principalProvider)return principalProvider();
    const config=JSON.parse(await readFile(path.join(process.env.CODEX_HOME??path.join(os.homedir(),'.codex'),'task-workbench-light/config.json'),'utf8'));
    const grant=Object.entries(persistence.read('grants')).find(([,g])=>g.kind==='lightAccess'&&g.automatic&&!g.revokedAt&&(g.appId??'codex')==='codex'&&g.tokenHash===digest(config.token));
    if(!grant)lightError('CODEX_NOT_CONNECTED','尚未连接 Codex，请先在设置中连接',409);return grant[0];
  }
  const base=(run,eventId)=>{const s=snapshot(),p=s.plans.find(p=>p.key===run.planKey),project=s.projects.find(x=>x.key===p.projectKey);const {trust,...source}=p.source;return {schemaVersion:'light-1.0',projectId:project.id,planId:p.id,expectedRevision:project.revision,eventId:run.id+'/'+eventId,source,occurredAt:stamp(),reason:'用户开启按阶段连续执行'};};
  async function verifySource(plan){let bytes;try{bytes=await readFile(plan.source.path);}catch{lightError('SOURCE_UNAVAILABLE',`无法读取方案原文，请恢复文件后重试：${plan.source.path}`,409);}if(createHash('sha256').update(bytes).digest('hex')!==plan.source.sha256)lightError('SOURCE_CHANGED',`方案原文已变化，请先同步方案修订后重试：${plan.source.path}`,409);}
  async function workspace(plan,step){
    const route=snapshot().routes.find(r=>r.planKey===plan.key&&r.stepKeys.includes(step.key));
    if(!route?.context?.worktreePath)lightError('STAGE_ROUTE_REQUIRED',`阶段 ${step.code} 尚未登记工作目录`,409);
    let cwd;try{cwd=await realpath(route.context.worktreePath);if(!(await stat(cwd)).isDirectory())throw Error('NOT_DIRECTORY');}catch{lightError('WORKSPACE_UNAVAILABLE',`阶段 ${step.code} 的工作目录不存在或不可访问，请修正路线目录：${route.context.worktreePath}`,409);}
    const observed=await inspectWorkspace(cwd);
    if(observed.branch!==route.context.branch)lightError('WORKSPACE_BRANCH_CHANGED',`阶段 ${step.code} 的实际分支与登记不一致，请先核对工作树`,409);
    return {route,cwd,observed};
  }
  async function preflight(plan,mode,run){
    await principal();await verifySource(plan);
    const s=snapshot(),pending=s.steps.filter(x=>x.planKey===plan.key&&x.parentKey===null&&x.required&&!stepPassed(s,x));
    if(run?.sourceHash!==undefined&&run.sourceHash!==plan.source.sha256&&pumps.has(run.id))lightError('SOURCE_REVISION_REVIEW','方案已修订，请等待原会话本轮结束并核对当前阶段后再恢复',409);
    if(run?.sourceHash!==undefined&&run.sourceHash!==plan.source.sha256&&run.current){
      const current=s.steps.find(x=>x.key===run.current.stepKey);
      if(!current||!stepPassed(s,current))lightError('SOURCE_REVISION_REVIEW','方案已修订，当前阶段尚未重新验收；请先在原会话核对并同步结果，再恢复连续执行',409);
    }
    const currentStep=s.steps.find(x=>x.key===run?.current?.stepKey),currentBinding=s.bindings.find(b=>b.key===currentStep?.bindingKey);
    let firstPath=mode==='current_thread'?(currentBinding?.context.worktreePath??(run?.mode==='current_thread'?run.session?.cwd:null)):null;
    for(const step of pending){const {cwd}=await workspace(plan,step);if(mode==='current_thread'){if(firstPath&&!samePath(firstPath,cwd))lightError('WORKSPACE_MISMATCH','当前会话模式不能跨不同工作树，请选择“阶段完成后接续新会话”',409);firstPath??=cwd;}}
    const ongoing=pending.filter(x=>x.status==='running');
    if(mode==='current_thread'&&new Set(ongoing.map(x=>s.bindings.find(b=>b.key===x.bindingKey)?.context.threadId)).size>1)lightError('MULTIPLE_ACTIVE_THREADS','多个会话正在执行，请使用按阶段接续或先处理现有会话',409);
    for(const step of ongoing){const binding=s.bindings.find(b=>b.key===step.bindingKey);if(!binding?.context.threadId)lightError('THREAD_ID_REQUIRED',`阶段 ${step.code} 缺少真实会话身份，请先核对绑定`,409);}
  }
  async function prepare(run,step,client){
    const s=snapshot(),plan=s.plans.find(p=>p.key===run.planKey);
    await verifySource(plan);
    if(find(run.id).status!=='running')return null;
    const {route,cwd,observed}=await workspace(plan,step);
    if(run.mode==='current_thread'&&run.session&&!samePath(run.session.cwd,cwd))lightError('WORKSPACE_MISMATCH','当前会话不能执行其他工作树的阶段，请切换按阶段接续',409);
    const cwdKey=cwd.toLowerCase();
    if(workspaceClaims.has(cwdKey)&&workspaceClaims.get(cwdKey)!==run.id)throw Error('WORKSPACE_BUSY');
    workspaceClaims.set(cwdKey,run.id);
    // 同目录只启动一条执行线，已有执行需先完成或接手原会话。
    if(s.executions.some(e=>!e.endedAt&&s.bindings.some(b=>b.key===e.bindingKey&&path.resolve(b.context.worktreePath).toLowerCase()===cwd.toLowerCase())))throw Error('WORKSPACE_BUSY');
    const current={stepId:step.id,stepKey:step.key,code:step.code,threadId:null,creationAttempted:true,turnId:null};
    let thread;
    if(run.mode==='current_thread'&&run.session){
      const response=await client.resume(run.session.threadId);thread=response?.thread;
      if(thread?.id!==run.session.threadId||!thread.cwd||!samePath(await realpath(thread.cwd),cwd))lightError('THREAD_WORKSPACE_MISMATCH','原会话的实际目录已变化，未派发下一阶段；请核对会话目录或改用按阶段接续',409);
      current.creationAttempted=false;
    }else{
      await update(run.id,{current});
      thread=await client.create(cwd,`${plan.name} / ${step.code}：${step.title}`);
    }
    current.threadId=thread.id;await update(run.id,{current});
    if(run.mode==='current_thread'&&!run.session)await update(run.id,{session:{threadId:thread.id,cwd,transport:'owned'}});
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
    const dispatch=run.mode==='current_thread'?'后续阶段继续使用当前会话，任务岛在验收通过后发送下一阶段指令。':'后续阶段按方案边界创建独立会话。';
    return `开始执行 ${plan.name} / ${stage.code}：${stage.title}\n日期：${new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date())}\n用户已在任务岛点击“连续执行”，授权在该方案既定范围内执行、同步进度及接续直至整体结束。${dispatch}你只负责本阶段及其子步骤，完成后如实同步，由任务岛调度下一阶段，不自行创建聊天，不提前执行未派发阶段。\n读取当前安装的 workbench-handoff 技能和方案原文：${plan.source.path}。核对适用AGENTS.md。不要重新登记方案。实际任务执行与验收必须按原文，不凭预设或自述标记通过。若方案明确为空任务模拟，按原文等待及返回值执行。\n真实会话ID：${current.threadId}；宿主local。总控已完成此会话的绑定及本阶段running登记。复用以下身份，不重复预留本阶段executionId，不接手别的责任。每次状态写入前回读最新版本。\n${JSON.stringify({projectId:s.projects.find(p=>p.key===plan.projectKey).id,planId:plan.id,bindingId:current.bindingId,bindingRevision:current.bindingRevision,executionId:current.executionId,stageId:current.stepId,scope:scope.map(x=>({id:x.id,code:x.code,parentKey:x.parentKey,dependsOn:x.dependsOn,conditions:x.conditions,status:x.status}))},null,2)}\n使用工作台MCP回读并按实际结果同步。子步骤依次取得各自开始许可和executionId，沿用本阶段父级责任绑定覆盖子步骤；全部必要子步骤完成验收后，完成本阶段。保留可回读的实际证据。提交completed前逐项匹配服务中的conditionId、text、required，result=passed并关联passed证据。参数被明确拒绝时按validationErrors修正后继续。\n已授权且仍有必要修复时继续本阶段；真正外部阻塞、失败或需人工决定时如实标记blocked并报告原因。禁止越过前置或把会话结束当成阶段成功。`;
  }
  async function notifyCurrent(id,client){
    if(notifications.has(id)){
      await notifications.get(id);
      const fresh=find(id);
      if(fresh?.status==='running'&&fresh.mode==='current_thread'&&fresh.current&&fresh.current.delivery?.intent!==fresh.intent)return notifyCurrent(id,client);
      return;
    }
    const pending=deliverCurrent(id,client);notifications.set(id,pending);
    try{return await pending;}finally{if(notifications.get(id)===pending)notifications.delete(id);}
  }
  async function deliverCurrent(id,client){
    let current,run,send=false,attempted=false;
    await persistence.run(()=>{
      const value=state();run=value.runs.find(r=>r.id===id);current=run?.current;
      const step=snapshot()?.steps.find(x=>x.key===current?.stepKey);
      if(!run||run.status!=='running'||run.mode!=='current_thread'||!current?.threadId||!step||stepPassed(snapshot(),step))return;
      if(current.delivery?.state==='unknown')lightError('DELIVERY_UNKNOWN','上次指令投递结果未知，请先核对原会话，避免重复发送',409);
      if(current.delivery?.intent===run.intent&&['sending','sent'].includes(current.delivery.state))return;
      current.delivery={intent:run.intent,state:'sending',attemptId:randomUUID()};run.phase='notifying';
      persistence.write('lightContinuous',value);send=true;
    });
    if(!send)return;
    const stillCurrent=()=>{const fresh=find(id),s=snapshot(),step=s.steps.find(x=>x.key===current.stepKey);return fresh?.status==='running'&&fresh.mode==='current_thread'&&fresh.intent===run.intent&&fresh.current?.stepKey===current.stepKey&&fresh.current?.threadId===current.threadId&&fresh.current?.delivery?.attemptId===current.delivery.attemptId&&step&&!stepPassed(s,step);};
    const cancel=async()=>{await persistence.run(()=>{const value=state(),fresh=value.runs.find(r=>r.id===id);if(fresh?.current?.delivery?.attemptId===current.delivery.attemptId){fresh.current.delivery.state='cancelled';persistence.write('lightContinuous',value);}});};
    const plan=snapshot().plans.find(p=>p.key===run.planKey);
    const text=`日期：${new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date())}\n用户已在任务岛开启“立即通知当前会话持续执行”。请持续完成方案 ${plan.name}（${plan.id}）当前阶段 ${current.code} 及其必要子步骤，在既定范围内完成修复、验证与工作台状态同步，不因等待重复许可而停下。原文：${plan.source.path}。保留当前会话、绑定与执行身份，不重复登记或重复执行已通过步骤。当前阶段验收后，任务岛会在本会话继续派发后续阶段；不要提前越过依赖或自行派发。真正阻塞或需人工决定时如实报告。`;
    try{
      if(typeof client.notify!=='function')lightError('CURRENT_THREAD_UNAVAILABLE','当前宿主未提供会话消息接口，请连接 Codex 桌面后重试',409);
      const thread=await client.attach(current.threadId);
      if(!stillCurrent()){await cancel();return;}
      if(!thread.cwd||!run.session?.cwd||!samePath(thread.cwd,run.session.cwd))lightError('THREAD_WORKSPACE_MISMATCH','原会话目录与当前方案工作树不一致，未发送指令',409);
      if(thread.status?.activeFlags?.some(flag=>['waitingOnApproval','waitingOnUserInput'].includes(flag)))lightError('CODEX_INTERACTION_REQUIRED','当前会话正在等待人工批准或输入，请处理后重试',409);
      attempted=true;
      const result=await client.notify(current.threadId,text,current.adopted?undefined:{expectedTurnId:current.turnId,allowIdle:false});
      await persistence.run(()=>{const value=state(),fresh=value.runs.find(r=>r.id===id);if(fresh?.current?.delivery?.attemptId===current.delivery.attemptId){fresh.current.delivery={...current.delivery,state:'sent',...result};if(fresh.status==='running')fresh.phase='executing';persistence.write('lightContinuous',value);}});
    }catch(error){
      const notSent=error.code==='CODEX_ACTIVE_TURN_UNKNOWN';
      if((!attempted||notSent)&&!stillCurrent()){await cancel();return;}
      await persistence.run(()=>{const value=state(),fresh=value.runs.find(r=>r.id===id);if(fresh?.current?.delivery?.attemptId===current.delivery.attemptId){fresh.current.delivery={...current.delivery,state:!notSent&&/UNKNOWN|TIMEOUT/.test(error.message)?'unknown':'rejected'};persistence.write('lightContinuous',value);}});throw error;
    }
  }
  async function pump(id){
    if(pumps.has(id)||closed)return;pumps.add(id);
    let client;
    function connection(transport='owned'){if(!client||client.__runnerTransport!==transport){client?.close();client=clientFactory({transport});client.__runnerTransport=transport;clients.set(id,client);}return client;}
    try{
      while(!closed){
        let run=find(id);if(!run||!activeStates.has(run.status))return;
        if(run.status==='pausing'){await pauseIfRequested(id,'已暂停接续');return;}
        const s=snapshot(),plan=s?.plans.find(p=>p.key===run.planKey);if(!plan)throw Error('PLAN_NOT_FOUND');
        if(plan.source.sha256!==run.sourceHash)throw Error('SOURCE_CHANGED');
        await verifySource(plan);
        const stages=s.steps.filter(x=>x.planKey===plan.key&&x.parentKey===null&&x.required).sort((a,b)=>a.order-b.order);
        let current=run.current;
        if(current?.delivery?.state==='unknown')lightError('DELIVERY_UNKNOWN','上次通知投递结果未知，请先核对原会话，不能重复发送或派发下一阶段',409);
        if(current?.adopted){
          const step=s.steps.find(x=>x.key===current.stepKey);
          if(step&&stepPassed(s,step)){
            if(run.mode==='current_thread'){
              const thread=await connection(run.session?.transport??'shared').readThread(current.threadId),last=thread.turns?.at(-1);
              if(thread.status?.type==='active'||last?.status==='inProgress'){await update(id,{phase:'waiting',reason:'阶段已验收，等待当前会话结束后接续'});await new Promise(resolve=>setTimeout(resolve,1000));continue;}
            }
            const latestRun=find(id);
            await update(id,{current:null,reason:'',history:[...latestRun.history,{stepKey:current.stepKey,threadId:current.threadId,turnId:current.delivery?.turnId??null,turnStatus:'observed',adopted:true,at:stamp()}]});continue;
          }
          if(step?.status!=='running')throw Error('原执行阶段需要处理阻塞后继续');
          if(run.mode==='current_thread'){
            const currentClient=connection(run.session?.transport??'shared');
            await notifyCurrent(id,currentClient);
            const thread=await currentClient.readThread(current.threadId),last=thread.turns?.at(-1);
            if(currentClient.interactionRequired)lightError('CODEX_INTERACTION_REQUIRED','当前会话正在等待人工批准或输入，请处理后重试',409);
            if(thread.status?.type!=='active'&&last&&last.status!=='inProgress')throw Error('原阶段会话已结束但尚未通过验收，请在该会话处理后重试');
          }else await update(id,{phase:'waiting',reason:'已开启，等待当前阶段完成并验收后接续'});
          await new Promise(resolve=>setTimeout(resolve,1000));continue;
        }else if(current){
          if(!current.threadId)throw Error('THREAD_CREATION_RESULT_UNKNOWN');
          const step=s.steps.find(x=>x.key===current.stepKey);
          if(step&&stepPassed(s,step)){await update(id,{current:null});continue;}
          if(!current.executionId)throw Error('INCOMPLETE_START_REQUIRES_REVIEW');
          if(['sending','unknown'].includes(current.turnDelivery))lightError('DELIVERY_UNKNOWN','阶段启动结果未知，请先核对原会话，避免重复执行',409);
          const resumed=await connection(run.mode==='current_thread'?run.session?.transport:'owned').resume(current.threadId);
          const {cwd}=await workspace(plan,step);
          if(resumed?.thread?.id!==current.threadId||!resumed.thread.cwd||!samePath(await realpath(resumed.thread.cwd),cwd))lightError('THREAD_WORKSPACE_MISMATCH','原会话的实际目录已变化，请核对会话目录后重试',409);
        }else{
          connection(run.mode==='current_thread'?run.session?.transport:'owned');
          const pending=stages.filter(x=>!stepPassed(s,x));
          if(!pending.length){
            if(plan.endConditions.some(c=>c.required&&c.result!=='passed')){
              const last=run.history.at(-1)??run.session;if(!last?.threadId)throw Error('方案结束条件尚未验收');
              if(last.adopted||run.session?.transport==='shared')connection('shared');
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
            await update(id,{status:'completed',enabled:false,phase:null,current:null,reason:'整个方案已完成并通过验收'});return;
          }
          const ongoing=pending.find(x=>x.status==='running');
          if(ongoing){const binding=s.bindings.find(b=>b.key===ongoing.bindingKey);if(!binding?.context.threadId)throw Error('现有执行缺少真实会话身份');const current={adopted:true,stepId:ongoing.id,stepKey:ongoing.key,code:ongoing.code,threadId:binding.context.threadId};const fields={current,phase:run.mode==='current_thread'?'notifying':'waiting'};if(run.mode==='current_thread')fields.session={threadId:current.threadId,cwd:await realpath(binding.context.worktreePath),transport:'shared'};await update(id,fields);continue;}
          const step=pending.find(x=>x.status==='pending'&&!waitingFor(s,x).length&&!x.blockers.some(b=>!b.resolved));
          if(!step)throw Error('阶段存在阻塞、取消、未结束执行或未满足前置，需先处理后继续');
          await update(id,{phase:'dispatching',reason:''});current=await prepare(run,step,client);if(!current){await pauseIfRequested(id,'已暂停接续');return;}run=find(id);
        }
        await update(id,{phase:'executing',reason:''});
        current={...current,turnDelivery:'sending'};await update(id,{current});
        const turn=await client.run(current.threadId,prompt(run,current),async turnId=>{current={...find(id).current,turnId,turnDelivery:'started'};await update(id,{current});if(run.mode!=='current_thread'&&find(id)?.mode==='current_thread')await notifyCurrent(id,client);});
        if(notifications.has(id))await notifications.get(id);
        if(closed)return;
        const latest=snapshot(),step=latest.steps.find(x=>x.key===current.stepKey);
        const after=find(id);
        if(after.current?.delivery?.state==='unknown')lightError('DELIVERY_UNKNOWN','通知投递结果未知，已保留当前阶段身份；请先核对原会话',409);
        const history=[...after.history,{stepKey:current.stepKey,threadId:current.threadId,turnId:current.turnId,turnStatus:turn.status,at:stamp()}];
        await update(id,{history});
        if(turn.status!=='completed'||client.interactionRequired)throw Error(client.interactionRequired?'需要人工确认，请处理该阶段会话后继续':'阶段会话失败或被中断');
        if(!stepPassed(latest,step))throw Error('阶段会话已结束，但工作台验收未通过；请在该会话修复后继续');
        await update(id,{current:null});
        if(find(id).status==='pausing'){await pauseIfRequested(id,'当前阶段已完成，后续阶段已暂停');return;}
      }
    }catch(error){if(!closed){const run=find(id);await update(id,{status:enabled(run)?'blocked':'paused',phase:null,...(run.current?.turnDelivery==='sending'?{current:{...run.current,turnDelivery:'unknown'}}:{}),reason:failureReason(error)});}}
    finally{client?.close();clients.delete(id);pumps.delete(id);for(const [cwd,owner]of workspaceClaims)if(owner===id)workspaceClaims.delete(cwd);if(!closed&&find(id)?.status==='running')setTimeout(()=>void pump(id),0);}
  }
  return {
    async initialize(){await persistence.run(()=>{const s=state();for(const r of s.runs){r.mode??='stages';r.enabled=enabled(r);if(activeStates.has(r.status)){r.status='paused';r.enabled=false;r.phase=null;r.reason='服务已重启，请点击继续，复用原阶段会话核验恢复';}if(r.current?.delivery?.state==='sending')r.current.delivery.state='unknown';}persistence.write('lightContinuous',s);});},
    read(){const runs=state().runs,s=snapshot();return [...runs.map(summary),...(s?.plans??[]).filter(plan=>!runs.some(run=>run.planKey===plan.key)&&planProgress(s,plan.key).passed).map(plan=>summary(completedRun(plan)))];},
    async change(input){
      if(!input||Object.keys(input).some(k=>!['planKey','action','expectedRevision','acknowledged','mode'].includes(k))||input.acknowledged!==true||!['start','pause','resume'].includes(input.action)||typeof input.planKey!=='string'||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||(input.mode!==undefined&&!modes.has(input.mode)))lightError('INVALID_INPUT','连续执行请求无效');
      let run,changed=false;
      const initial=snapshot(),plan=initial?.plans.find(p=>p.key===input.planKey),previous=state().runs.find(r=>r.planKey===input.planKey);
      if(!plan)lightError('NOT_FOUND','方案不存在',404);
      if(planProgress(initial,plan.key).passed){
        if(previous)await update(previous.id,{status:'completed',enabled:false,phase:null,current:null,reason:'整个方案已完成并通过验收'});
        return {saved:true,run:summary(previous?find(previous.id):completedRun(plan))};
      }
      const mode=input.mode??previous?.mode??'stages';
      if(input.action!=='pause'){
        const project=initial.projects.find(p=>p.key===plan.projectKey);
        if(project.revision!==input.expectedRevision)lightError('REVISION_CONFLICT','任务已更新，请刷新重试',409);
        await preflight(plan,mode,previous);
      }
      await persistence.run(async()=>{
        const snap=snapshot(),plan=snap?.plans.find(p=>p.key===input.planKey),project=snap?.projects.find(p=>p.key===plan?.projectKey);
        if(!plan||!project)lightError('NOT_FOUND','方案不存在');
        if(input.action!=='pause'&&project.revision!==input.expectedRevision)lightError('REVISION_CONFLICT','任务已更新，请刷新重试',409);
        const s=state();run=s.runs.find(r=>r.planKey===plan.key);
        if(input.action==='pause'){if(run&&run.status!=='completed'){const draining=activeStates.has(run.status)&&pumps.has(run.id);run.enabled=false;run.status=draining?'pausing':'paused';run.phase=null;run.reason='连续执行已关闭，当前阶段完成后暂停';}}
        else{
          if(run&&run.sourceHash!==plan.source.sha256){
            // 明确同步的新版本只在当前责任已验收的边界采用，保留原会话与历史。
            run.sourceHash=plan.source.sha256;run.current=null;run.previousRunIds=[...(run.previousRunIds??[]),run.id];run.id=randomUUID();
            if(run.status==='completed')run.status='paused';
          }
          if(!run){run={id:randomUUID(),planKey:plan.key,sourceHash:plan.source.sha256,status:'running',mode,enabled:true,intent:1,phase:'dispatching',current:null,history:[],createdAt:stamp(),updatedAt:stamp(),reason:''};s.runs.push(run);changed=true;}
          else if(run.status!=='completed'){
            changed=run.status!=='running'||run.mode!==mode;
            if(changed){run.intent=(run.intent??0)+1;run.status='running';run.enabled=true;run.reason='';run.phase=run.current?'waiting':'dispatching';run.mode=mode;}
          }
          if(mode==='current_thread'&&run.current?.threadId&&run.session?.threadId!==run.current.threadId){
            const step=snap.steps.find(x=>x.key===run.current.stepKey),binding=snap.bindings.find(b=>b.key===step?.bindingKey);
            if(binding)run.session={threadId:run.current.threadId,cwd:await realpath(binding.context.worktreePath),transport:run.current.adopted?'shared':'owned'};
          }
        }
        if(run)run.updatedAt=stamp();
        persistence.write('lightContinuous',s);
      });
      if(changed&&run?.status==='running'&&run.mode==='current_thread'&&pumps.has(run.id)&&clients.has(run.id)&&run.current?.threadId&&(run.current.adopted||run.current.turnId)){
        void notifyCurrent(run.id,clients.get(run.id)).catch(async error=>{if(!closed&&find(run.id)?.status==='running')await update(run.id,{status:'blocked',phase:null,reason:failureReason(error)});});
      }
      if(run?.status==='running')setTimeout(()=>void pump(run.id),0);
      return {saved:true,run:run?summary(run):null};
    },
    close(){closed=true;for(const c of clients.values())c.close();},
  };
}
