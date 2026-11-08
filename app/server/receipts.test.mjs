import test from 'node:test';
import assert from 'node:assert/strict';
import {applyReceiptCommand as apply,inspectReceipts as inspect} from './receipts.mjs';
const model=()=>({folders:[{id:'F'}],tasks:[{id:'T',folderId:'F',acceptance:['任务交付'],handoff:'下游任务'}],chats:[{id:'C1',taskId:'T',folderId:'F'},{id:'C2',taskId:'T',folderId:'F'}],plans:[{id:'V',version:'1',source:'原文',previousId:null}],initialPlanId:'V',currentPlanId:'V',acceptance:['项目验收'],stations:['A','B','Z'].map(id=>({id,taskId:'T',code:id,title:id,scope:'既定范围',planId:'V',acceptance:['测试通过'],dependsOn:id==='Z'?['A','B']:[],successors:id==='Z'?[]:['Z']}))});
const receipt=(m,id,overrides={})=>({projectId:'P',folderId:'F',taskId:'T',stationId:id,planId:'V',sourceId:'C1',deliveryVersion:'commit-1',raw:'日期：2026-11-08\n声称完成',actual:'本次实现',blockers:[],checks:[{criterion:'测试通过',result:'passed'}],next:m.stations.find(s=>s.id===id).successors.map(stationId=>({stationId,goal:'验证',scope:'不同措辞表达同一范围',delivery:'验收报告'})),...overrides});
const review=(m,id,overrides={})=>({reviewer:'测试核验人',method:'读取隔离测试输出并比较交付版本',checks:[{criterion:'测试通过',result:'passed',reason:'实际测试成功',evidenceIds:['e']}],taskChecks:[{criterion:'任务交付',result:'passed',reason:'交付完整',evidenceIds:['e']}],projectChecks:[{criterion:'项目验收',result:'passed',reason:'组合验收通过',evidenceIds:['e']}],evidence:[{id:'e',location:'artifacts/result.json',deliveryVersion:'commit-1',method:'读取结果并对照提交',reason:'报告版本对应且结果通过',result:'valid'}],handoffs:m.stations.find(s=>s.id===id).successors.map(stationId=>({stationId,result:'matched',reason:'目标、范围与验收交付一致，允许不同措辞'})),...overrides});
function imported(m,id,overrides={}){return apply('P',m,{action:'import',receipt:receipt(m,id,overrides)});}
function reviewed(m,id,overrides={}){const e=m.receiptLog.receipts.filter(e=>e.receipt.stationId===id).at(-1);return apply('P',m,{action:'review',receiptId:e.id,review:review(m,id,overrides)});}
const result=(m,id)=>inspect('P',m).results[id];

test('自述完成不等于通过；证据缺失、版本错误及未知状态均不通过',()=>{
 let m=imported(model(),'A');assert.equal(result(m,'A').conclusion,'B');
 m=reviewed(m,'A',{evidence:[]});assert.equal(result(m,'A').conclusion,'B');
 m=reviewed(m,'A',{evidence:[{...review(m,'A').evidence[0],deliveryVersion:'old'}]});assert.equal(result(m,'A').conclusion,'B');
 assert.throws(()=>reviewed(m,'A',{checks:[{criterion:'测试通过',result:'invented',reason:'x',evidenceIds:[]}]}),/非法/);
});
test('验收失败留在本站 A；回执未决事项阻止通过',()=>{
 let m=imported(model(),'A');m=reviewed(m,'A',{checks:[{criterion:'测试通过',result:'failed',reason:'实际失败',evidenceIds:['e']}]});assert.equal(result(m,'A').conclusion,'A');
 m=imported(m,'A',{blockers:['必要修复未完成']});m=reviewed(m,'A');assert.equal(result(m,'A').conclusion,'A');
});
test('编号相同但范围不符为 G；措辞不同可匹配；合流等待全部依赖 C→D',()=>{
 let m=reviewed(imported(model(),'A'),'A',{handoffs:[{stationId:'Z',result:'mismatch',reason:'虽然编号相同，但扩大范围'}]});assert.equal(result(m,'A').conclusion,'G');
 m=reviewed(m,'A');assert.equal(result(m,'A').conclusion,'C');assert.deepEqual(result(m,'A').handoffs[0].waiting,['B']);
 m=reviewed(imported(m,'B'),'B');assert.equal(result(m,'A').conclusion,'D');assert.equal(result(m,'B').conclusion,'D');
 m=reviewed(imported(m,'Z'),'Z');assert.equal(result(m,'Z').conclusion,'F');
});
test('边上未匹配不解锁后继；缺尾部为待核验 B',()=>{
 let m=reviewed(imported(model(),'A',{next:[]}),'A');assert.equal(result(m,'A').conclusion,'B');
 m=reviewed(imported(m,'B'),'B');m=reviewed(imported(m,'Z'),'Z');assert.equal(result(m,'Z').conclusion,'C');
});
test('多任务分别交付 E，项目未验收不冒充 F',()=>{
 let m=model();m.stations=m.stations.slice(0,1).map(s=>({...s,successors:[]}));m.acceptance=['尚需集成'];
 m=reviewed(imported(m,'A'),'A');assert.equal(result(m,'A').conclusion,'E');
 assert.match(result(m,'A').reason,/下游任务/);
});
test('同文件夹换聊天续接保留历史，异文件夹同名回执隔离',()=>{
 let m=reviewed(imported(model(),'A'),'A');m=imported(m,'A',{sourceId:'C2',raw:'第二个聊天回执'});assert.equal(m.receiptLog.receipts.length,2);assert.equal(result(m,'A').conclusion,'B');
 m=imported(m,'A',{folderId:'OTHER'});assert.equal(inspect('P',m).quarantined.length,1);assert.throws(()=>reviewed(m,'A'),/归属/);
});
test('重复导入与核验不新增事件；证据失效保留历史并停止解锁',()=>{
 let m=imported(model(),'A');assert.equal(imported(m,'A'),null);
 m=reviewed(m,'A');assert.equal(reviewed(m,'A'),null);const id=m.receiptLog.reviews[0].id;
 m=apply('P',m,{action:'invalidate',reviewId:id,reason:'报告已被撤回'});assert.equal(result(m,'A').conclusion,'B');assert.equal(m.receiptLog.reviews.length,1);assert.equal(apply('P',m,{action:'invalidate',reviewId:id,reason:'再次失效'}),null);
});
test('方案头或依赖变化使核验失效，旧原文及判断仍保留',()=>{
 let m=reviewed(imported(model(),'A'),'A');m.stations[0].scope='修订范围';assert.equal(result(m,'A').conclusion,'B');assert.match(result(m,'A').reason,/待复核/);assert.equal(m.receiptLog.reviews.length,1);
});
test('未知后继不得自动扩展路线',()=>{
 let m=reviewed(imported(model(),'A',{next:[{stationId:'EXTRA',goal:'新增',scope:'扩展',delivery:'额外产物'}]}),'A');assert.equal(result(m,'A').conclusion,'G');assert.equal(m.stations.length,3);
});
test('未受影响的换聊天不失效；核验纠正可再次提交先前相同判断',()=>{
 let m=reviewed(imported(model(),'A'),'A');m.chats.push({id:'C3',taskId:'T',folderId:'F'});assert.equal(result(m,'A').conclusion,'C');
 m=reviewed(m,'A',{checks:[{criterion:'测试通过',result:'failed',reason:'修正为失败',evidenceIds:['e']}]});assert.equal(result(m,'A').conclusion,'A');
 m=reviewed(m,'A');assert.equal(result(m,'A').conclusion,'C');assert.equal(m.receiptLog.reviews.length,3);
});
test('任务终点后来的失败核验不能被旧通过覆盖；跨任务交付可独立结束',()=>{
 let merged=model();for(const id of ['A','B','Z'])merged=reviewed(imported(merged,id),id);merged=reviewed(merged,'Z',{taskChecks:[{criterion:'任务交付',result:'failed',reason:'最新终点核验失败',evidenceIds:['e']}]});assert.equal(result(merged,'Z').conclusion,'A');
 let m=model();m.stations=m.stations.slice(0,1).map(s=>({...s,successors:[]}));m=reviewed(imported(m,'A'),'A');assert.equal(result(m,'A').conclusion,'F');
 m=reviewed(m,'A',{taskChecks:[{criterion:'任务交付',result:'failed',reason:'交付不完整',evidenceIds:['e']}]});assert.equal(result(m,'A').conclusion,'A');
 m=model();m.tasks.push({id:'U',folderId:'F',acceptance:['集成']});m.stations=m.stations.filter(s=>s.id!=='B');m.stations.find(s=>s.id==='Z').taskId='U';m.stations.find(s=>s.id==='Z').dependsOn=['A'];
 m=reviewed(imported(m,'A'),'A');assert.equal(result(m,'A').conclusion,'E');assert.equal(result(m,'Z').conclusion,'B');
});
test('新版不能掩盖初始项目目标与验收条件',()=>{
 let m=model();m.plans[0].goal='原定交付';m.plans[0].acceptance=['原始验收'];m.stations=m.stations.slice(0,1).map(s=>({...s,successors:[]}));
 m=reviewed(imported(m,'A'),'A');assert.equal(result(m,'A').conclusion,'E');
 const extra=['项目验收','原始验收','原始目标：原定交付'].map(criterion=>({criterion,result:'passed',reason:'逐项核对原始要求',evidenceIds:['e']}));
 m=reviewed(m,'A',{projectChecks:extra});assert.equal(result(m,'A').conclusion,'F');
});
