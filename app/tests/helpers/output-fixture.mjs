import {applyReceiptCommand} from '../../server/receipts.mjs';
import {reconcileLifecycle,inspectMonitor} from '../../server/monitor.mjs';
import {capturePlanSnapshots} from '../../server/plan-diff.mjs';

export const project={id:'00000000-0000-4000-8000-000000000005',name:'独立样例项目',goal:'原始项目目标',source:'原文',steps:[]};
export function model(){
 const m={folders:[{id:'F',name:'样例文件夹',externalId:'external-project'}],tasks:[{id:'T',name:'样例任务',folderId:'F',goal:'任务交付目标',initialGoal:'任务交付目标',acceptance:['任务验收'],handoff:'集成任务'}],chats:[{id:'C',externalId:'sample-chat',taskId:'T',folderId:'F',repository:'G:\\sample',worktree:'G:\\sample',branch:'main',head:'123abc',time:'2026-11-08',location:'回执#1'}],plans:[{id:'V',version:'1.0',date:'2026-11-08',source:'日期：2026-11-08\n状态：已固定\n# 样例方案\n目标：原始项目目标\nA 实现；B 验收',sourcePath:'G:\\sample\\plan.md',chapter:'第 1—3 节',goal:'原始项目目标',acceptance:['项目验收'],previousId:null}],initialPlanId:'V',currentPlanId:'V',acceptance:['项目验收'],stations:[{id:'A',taskId:'T',code:'A',title:'实现既定功能',scope:'只实现既定功能',chapter:'第 2 节',planId:'V',acceptance:['功能验收'],dependsOn:[],successors:['B']},{id:'B',taskId:'T',code:'B',title:'完成既定验收',scope:'保留原定范围',chapter:'第 3 节',planId:'V',acceptance:['验收报告'],dependsOn:['A'],successors:[]}]};
 m.planSnapshots=capturePlanSnapshots({plans:[],stations:[]},m,0);return m;
}
export function receipt(m,id){const s=m.stations.find(s=>s.id===id);return {projectId:project.id,folderId:'F',taskId:s.taskId,stationId:id,planId:m.currentPlanId,sourceId:m.chats.find(c=>c.taskId===s.taskId).id,deliveryVersion:'sha1',raw:'日期：2026-11-08\n实际回执',actual:`${id} 实际交付`,blockers:[],checks:[],next:s.successors.map(stationId=>{const n=m.stations.find(s=>s.id===stationId);return {stationId,goal:n.title,scope:n.scope,delivery:n.acceptance.join('；')};})};}
export const check=criterion=>({criterion,result:'passed',reason:'检查版本与实际结果符合原验收',evidenceIds:['e']});
export function review(m,id,projectPassed=false){const s=m.stations.find(s=>s.id===id),t=m.tasks.find(t=>t.id===s.taskId);return {reviewer:'人工核验人',method:'读取实际隔离报告',checks:s.acceptance.map(check),taskChecks:[...t.acceptance,`原始任务目标：${t.initialGoal}`].map(check),projectChecks:projectPassed?['项目验收','原始目标：原始项目目标'].map(check):[],evidence:[{id:'e',location:'isolated-report.json',deliveryVersion:'sha1',method:'读取并核对',reason:'符合交付版本',result:'valid'}],handoffs:s.successors.map(stationId=>({stationId,result:'matched',reason:'目标、范围及交付对应'}))};}
export function command(m,body){return reconcileLifecycle(project.id,applyReceiptCommand(project.id,m,body)??m);}
export function complete(m,id,projectPassed=false,overrides={}){m=command(m,{action:'import',receipt:receipt(m,id)});return command(m,{action:'review',receiptId:m.receiptLog.receipts.at(-1).id,review:{...review(m,id,projectPassed),...overrides}});}
export function view(m){return {...inspectMonitor(project.id,m),model:m,revision:1};}
