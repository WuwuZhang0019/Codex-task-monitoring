import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadOutputTemplate,generateOutput} from './outputs.mjs';
import {comparePlans,capturePlanSnapshots} from './plan-diff.mjs';
import {project,model,receipt,review,complete,command,view} from '../tests/helpers/output-fixture.mjs';
import {createServer} from './index.mjs';
import {planSteps} from './plan-steps.mjs';

const template=await loadOutputTemplate();
const output=(m,stationId='A',extra={})=>generateOutput(project,view(m),{stationId,...extra},template);

test('最新模板按方案原文确定圈号和逐行完整步骤，登记子集不改变方案总数',async()=>{
 const source=await readFile(new URL('../../docs/99_归档/2026-11-10_旧路线/01_任务监测工作台_v1.0/01_执行方案/01_Codex任务状态监测工作台_可执行方案_2026-11-08.md',import.meta.url),'utf8');
 const steps=planSteps({source});assert.equal(steps.length,6);
 const m=model();m.plans[0].source=source;m.stations=[{...m.stations[0],id:'M06',code:'M06',title:steps[5].title,successors:[]}];
 const o=output(m,'M06'),text=o.instructions[0].text;
 assert.match(text,/1\. 任务名称\n⑥ 样例任务 \/ M06/);
 assert.match(text,/- 本方案一共为：共 6 步；分别是：\n\n  1\. M01：/);
 assert.match(text,/\n  6\. M06：完成端到端场景验收与使用交付\n/);
 assert.doesNotMatch(o.audit.text,/xx|3\. ……/);
 assert.match(output(model()).instructions[0].text,/任务名称\n待核实（原方案步骤顺序未核定）/);
 for(const bad of ['## 完整方案步骤\n1. A：一步\n3. B：两步','## 完整方案步骤\n1. A：一步\n2. A：重号',source+'\n## 完整方案步骤\n1. X：冲突'])assert.equal(planSteps({source:bad}),null);
 assert.deepEqual(planSteps({source:'## 完整方案步骤\n1. X：原定一步\n2. Z：原定两步\n'}),[{code:'X',title:'原定一步'},{code:'Z',title:'原定两步'}]);
});
test('A/B/D 限于必要修复、核验或合法后继，独立指令含完整环境、验收和新版回执顺序',()=>{
 let m=model(),b=output(m);assert.equal(b.conclusion,'B');assert.equal(b.instructions.length,1);assert.match(b.instructions[0].text,/仅补齐缺失证据或复核/);
 m=complete(m,'A',false,{checks:[{criterion:'功能验收',result:'failed',reason:'实际功能失败',evidenceIds:['e']}]});
 const a=output(m);assert.equal(a.conclusion,'A');assert.match(a.instructions[0].text,/仅修复原验收失败项：功能验收/);assert.equal(a.instructions[0].stationId,'A');
 m=complete(model(),'A');const d=output(m);assert.equal(d.conclusion,'D');assert.equal(d.instructions[0].stationId,'B');
 const text=d.instructions[0].text;for(const value of ['独立样例项目','external-project','G:\\sample','main','123abc','G:\\sample\\plan.md','1.0','第 3 节','B：完成既定验收','全部前置条件','对应交接边 matched','验收报告','Git 提交','停止条件','不自动执行下一站'])assert.ok(text.includes(value),value);
 assert.doesNotMatch(text,/PDSD|【需填写|共 xx/);assert.doesNotMatch(d.audit.text,/PDSD|【需填写/);
 const fields=text.split('11. 执行完成后必须返回的回执\n')[1].split('\n').filter(l=>l.startsWith('- ')).map(l=>l.slice(2).split('：')[0]);assert.deepEqual(fields,template.fields);
 assert.equal(d.report,null);
});
test('C 等待全部依赖，E 交接与 F 项目有效关闭，无执行指令且结束句固定',()=>{
 let m=model();m.stations.push({...m.stations[0],id:'X',code:'X',dependsOn:[],successors:['B']});m.stations[1].dependsOn.push('X');m=complete(m,'A');
 const c=output(m);assert.equal(c.conclusion,'C');assert.equal(c.instructions.length,0);assert.match(c.report.text,/等待对象：X/);assert.match(c.report.text,/恢复条件/);
 m=complete(complete(model(),'A'),'B');const e=output(m,'B');assert.equal(e.conclusion,'E');assert.equal(e.instructions.length,0);assert.match(e.report.text,/交接对象：集成任务/);assert.match(e.report.text,/本任务无下一步执行指令，到此结束/);
 m=complete(complete(model(),'A'),'B',true);const f=output(m,'B');assert.equal(f.conclusion,'F');assert.equal(f.instructions.length,0);assert.match(f.report.text,/本任务无下一步执行指令，到此结束/);assert.match(f.report.text,/项目有效关闭/);
});
test('G 保留头尾范围冲突和待决定事项，不生成扩展指令',()=>{
 const m=complete(model(),'A',false,{handoffs:[{stationId:'B',result:'mismatch',reason:'范围与验收不同'}]});const g=output(m);assert.equal(g.conclusion,'G');assert.equal(g.instructions.length,0);assert.match(g.report.text,/范围差异/);assert.match(g.report.text,/待决定事项/);assert.match(g.report.text,/范围与验收不同/);
});
test('历史关闭后证据失效改为 B，后继不能复用失效依赖；缺原始目标不输出 E/F',()=>{
 let m=complete(complete(model(),'A'),'B',true),closed=structuredClone(m.lifecycle.closures);
 m=command(m,{action:'invalidate',reviewId:m.receiptLog.reviews.at(-1).id,reason:'撤回证据'});const b=output(m,'B');assert.equal(b.conclusion,'B');assert.equal(b.report,null);assert.match(b.instructions[0].text,/失效|复核/);assert.deepEqual(m.lifecycle.closures,closed);
 m=complete(complete(model(),'A'),'B',true);m=command(m,{action:'invalidate',reviewId:m.receiptLog.reviews[0].id,reason:'上游版本失效'});const c=output(m,'B');assert.equal(c.conclusion,'C');assert.equal(c.instructions.length,0);assert.ok(c.report.text.includes('A 实现既定功能'));
 m=model();delete m.tasks[0].initialGoal;m=complete(complete(m,'A'),'B',true);assert.equal(output(m,'B').conclusion,'B');
});
test('身份和方案缺失明确待核实，多个来源不猜测，不改变原文和验收历史',async()=>{
 const m=model();m.chats.push({...m.chats[0],id:'C2'});m.plans[0].sourcePath='';delete m.folders[0].externalId;
 const before=structuredClone(m),archive=await readFile(new URL('../../docs/99_归档/2026-11-10_旧路线/01_任务监测工作台_v1.0/01_执行方案/02_任务收敛与交接指令_原文_2026-11-08.md',import.meta.url),'utf8');const b=output(m);
 assert.ok(b.warnings.some(w=>w.includes('方案路径待核实')));assert.ok(b.warnings.some(w=>w.includes('聊天来源待核实')));assert.match(b.instructions[0].text,/项目标识：待核实/);assert.deepEqual(m,before);assert.equal(await readFile(new URL('../../docs/99_归档/2026-11-10_旧路线/01_任务监测工作台_v1.0/01_执行方案/02_任务收敛与交接指令_原文_2026-11-08.md',import.meta.url),'utf8'),archive);
 const selected=output(m,'A',{sourceId:'C2'});assert.ok(!selected.warnings.some(w=>w.includes('聊天来源待核实')));
});
test('站点绑定不能证明方案步骤完整，不将已登记子集冒充方案总步数',()=>{
 const m=model();m.plans[0].source+='\nC 尚未登记的原方案步骤';
 const b=output(m);assert.match(b.instructions[0].text,/- 本方案一共为：待核实：尚未独立核定/);assert.match(b.instructions[0].text,/已登记的 2 个站点仅作定位/);assert.doesNotMatch(b.instructions[0].text,/共 2 步/);assert.match(b.audit.text,/其他权威方案或交接资料路径：待核实/);
});
test('两个方案版本目标、验收、站点与原文差异可查，缺历史快照不伪称已核验',()=>{
 const old=complete(complete(model(),'A'),'B',true),m=structuredClone(old);
 m.plans.push({...m.plans[0],id:'V2',version:'2.0',previousId:'V',source:'日期：2026-11-08\n新原文',goal:'新项目目标',acceptance:['新增验收'],impact:'修改验收，需重验'});m.currentPlanId='V2';m.stations[0].title='新版实现目标';m.stations[0].acceptance.push('新版验收');m.stations.forEach(s=>s.planId='V2');m.planSnapshots=capturePlanSnapshots(old,m,3);
 const d=comparePlans(m,view(m));assert.equal(d.initial.goal,'原始项目目标');assert.equal(d.current.goal,'新项目目标');assert.ok(d.fields.find(f=>f.field==='source').changed);assert.ok(d.fields.find(f=>f.field==='acceptance').changed);assert.equal(d.stationChanges[0].before.title,'实现既定功能');assert.equal(d.stationChanges[0].after.title,'新版实现目标');assert.match(d.currentConformance,/待核验/);assert.equal(d.initialConformance,'待核验');assert.equal(d.rechecks.length,2);assert.deepEqual(m.lifecycle.closures,old.lifecycle.closures);assert.deepEqual(m.planSnapshots[0],old.planSnapshots[0]);
 delete m.planSnapshots;assert.match(comparePlans(m,view(m)).impact,/待核验.*历史站点快照/);assert.equal(comparePlans(m,view(m)).stationChanges,null);
});
test('分叉逐边生成 D，回执范围和全部前置分别保留，不将可开始标为已开始',()=>{
 let m=model();m.stations.push({...m.stations[1],id:'C3',code:'C3'});m.stations[0].successors.push('C3');m=complete(m,'A');const d=output(m);assert.equal(d.conclusion,'D');assert.deepEqual(d.instructions.map(o=>o.stationId),['B','C3']);assert.ok(d.branches.every(b=>b.status==='D'));assert.ok(d.instructions.every(i=>i.text.includes('可开始不表示已经开始')));
});
test('分叉部分可开始与部分等待逐边处理，等待边没有执行指令',()=>{
 let m=model();m.stations.push({...m.stations[1],id:'C3',code:'C3',dependsOn:['A','X']},{...m.stations[0],id:'X',code:'X',successors:['C3']});m.stations[0].successors.push('C3');m=complete(m,'A');
 assert.equal(output(m).conclusion,'C');assert.equal(output(m).instructions.length,0);
 const ready=output(m,'A',{successorId:'B'});assert.equal(ready.conclusion,'D');assert.deepEqual(ready.instructions.map(i=>i.stationId),['B']);
 const waiting=output(m,'A',{successorId:'C3'});assert.equal(waiting.conclusion,'C');assert.equal(waiting.instructions.length,0);assert.match(waiting.report.text,/等待对象：X/);
 assert.throws(()=>output(m,'A',{successorId:'unknown'}),/不允许/);
});
test('HTTP 统一入口拒绝过期预览，快照不可被 PUT 篡改且冷重开保留',async t=>{
 const dataDir=await mkdtemp(path.join(tmpdir(),'m05-http-'));let server;
 async function open(){server=await createServer({dataDir,env:{}});await new Promise(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${server.address().port}`;}
 async function stop(){server.closeAllConnections();await new Promise(r=>server.close(r));}
 let base=await open();t.after(async()=>{await stop();await rm(dataDir,{recursive:true,force:true});});
 const request=async(url,method='GET',body)=>{const r=await fetch(base+url,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};};
 const {id:ignored,...input}=project;
 const created=await request('/api/projects','POST',input);assert.equal(created.status,201,JSON.stringify(created.data));
 const p=created.data.project,root=`/api/projects/${p.id}`;
 let saved=(await request(root+'/model')).data;saved.model=model();await request(root+'/model','PUT',saved);
 let a=await request(root+'/outputs','POST',{stationId:'A'});assert.equal(a.status,200);assert.equal(a.data.conclusion,'B');
 const first=(await request(root+'/model')).data;const initial=structuredClone(first.model.planSnapshots);first.model.planSnapshots=[];first.model.stations[0].scope='修改当前范围';await request(root+'/model','PUT',first);
 assert.equal((await request(root+'/outputs','POST',{stationId:'A',expectedFingerprint:a.data.fingerprint})).status,409);
 assert.deepEqual((await request(root+'/model')).data.model.planSnapshots,initial);
 assert.equal((await request(root+'/outputs','POST',{stationId:'unknown'})).status,400);assert.equal((await request('/api/projects/not-uuid/outputs','POST',{})).status,400);assert.equal((await request(root+'/outputs')).status,405);
 const before=(await request(root+'/outputs','POST',{stationId:'A'})).data;
 await stop();base=await open();assert.deepEqual((await request(root+'/outputs','POST',{stationId:'A'})).data,before);
});
