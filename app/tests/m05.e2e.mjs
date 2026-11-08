import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {createServer} from '../server/index.mjs';
import {model,receipt,review} from './helpers/output-fixture.mjs';

const dataDir=await mkdtemp(path.join(tmpdir(),'m05-browser-'));let server,browser;
const archive=new URL('../../docs/01_任务监测工作台_v1.0/01_执行方案/02_任务收敛与交接指令_原文_2026-11-08.md',import.meta.url),initialPlan=new URL('../../docs/01_任务监测工作台_v1.0/01_执行方案/01_Codex任务状态监测工作台_可执行方案_2026-11-08.md',import.meta.url);
const originals=await Promise.all([readFile(archive,'utf8'),readFile(initialPlan,'utf8')]);
try{
 server=await createServer({dataDir,env:{}});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 async function request(url,method='GET',body){const res=await fetch(base+url,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});assert.equal(res.ok,true,await res.clone().text());return res.json();}
 const p=(await request('/api/projects','POST',{name:'M05浏览器独立项目',goal:'原始项目目标',steps:[]})).project,root=`/api/projects/${p.id}`;
 let saved=await request(root+'/model');saved.model=model();await request(root+'/model','PUT',saved);
 async function complete(id,projectPassed=false){
  let state=await request(root+'/model');const r={...receipt(state.model,id),projectId:p.id};
  let v=await request(root+'/receipts','POST',{revision:state.revision,action:'import',receipt:r});
  return request(root+'/receipts','POST',{revision:v.revision,action:'review',receiptId:v.log.receipts.at(-1).id,review:review(state.model,id,projectPassed)});
 }
 browser=await chromium.launch({headless:true});const context=await browser.newContext({permissions:['clipboard-read','clipboard-write'],viewport:{width:1440,height:1100}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(base);
 await page.evaluate(()=>{const write=navigator.clipboard.writeText.bind(navigator.clipboard);navigator.clipboard.writeText=async text=>{window.lastClipboardInput=text;return write(text);};});
 const panel=page.getByRole('region',{name:'指令与方案差异'}),conclusion=panel.getByTestId('output-conclusion');
 await conclusion.waitFor();assert.match(await conclusion.textContent(),/当前结论：B/);
 async function copy(preview,button){const text=await panel.getByTestId(preview).textContent();await panel.getByRole('button',{name:button,exact:true}).click();await panel.getByRole('status').filter({hasText:'已复制当前预览'}).waitFor();assert.equal(await page.evaluate(()=>window.lastClipboardInput),text);assert.equal((await page.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,'\n'),text);return text;}
 const audit=await copy('output-audit','复制核对提示词');assert.match(audit,/仅核对和生成，不执行开发/);assert.doesNotMatch(audit,/PDSD|【需填写/);
 await copy('output-execution-0','复制执行指令 1');
 await complete('A');await panel.getByRole('button',{name:'重新生成输出',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-testid="output-conclusion"]')?.textContent.includes('当前结论：D'));
 const d=await copy('output-execution-0','复制执行指令 1');assert.match(d,/进入合法下一站/);assert.match(d,/B：完成既定验收/);assert.match(d,/HEAD 快照：123abc/);
 await panel.getByLabel('输出站点',{exact:true}).selectOption('B');await page.waitForFunction(()=>document.querySelector('[data-testid="output-conclusion"]')?.textContent.includes('当前结论：B'));
 const b=await copy('output-execution-0','复制执行指令 1');assert.match(b,/补齐本站必要核验/);assert.match(b,/样例任务 \/ B/);assert.notEqual(b,d);
 // A concurrent plan/head change must block copying the old preview.
 saved=await request(root+'/model');saved.model.stations[1].scope='更新后原定范围';await request(root+'/model','PUT',saved);
 await panel.getByRole('button',{name:'复制执行指令 1',exact:true}).click();await panel.getByRole('alert').filter({hasText:'状态或方案已变化'}).waitFor();assert.equal((await page.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,'\n'),b);assert.equal(await panel.getByTestId('output-execution-0').count(),0);
 await panel.getByRole('button',{name:'重新生成输出',exact:true}).click();await panel.getByTestId('output-execution-0').waitFor();assert.match(await panel.getByTestId('output-execution-0').textContent(),/更新后原定范围/);
 // Clipboard denial is visible and leaves the preview available for manual copy.
 await page.evaluate(()=>{window.originalWrite=navigator.clipboard.writeText.bind(navigator.clipboard);navigator.clipboard.writeText=async()=>{throw new Error('denied clipboard for acceptance');};});
 await panel.getByRole('button',{name:'复制执行指令 1',exact:true}).click();await panel.getByRole('alert').filter({hasText:'denied clipboard'}).waitFor();assert.equal(await panel.getByTestId('output-execution-0').count(),1);
 await page.evaluate(()=>{navigator.clipboard.writeText=window.originalWrite;});
 // Reverify the affected predecessor, then independently close task and project.
 await complete('A');await complete('B');await panel.getByRole('button',{name:'重新生成输出',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-testid="output-conclusion"]')?.textContent.includes('当前结论：E'));assert.equal(await panel.getByTestId('output-execution-0').count(),0);
 const e=await copy('output-report','复制等待或结束回执');assert.match(e,/本任务无下一步执行指令，到此结束/);assert.match(e,/交接对象：集成任务/);
 let state=await request(root+'/model'),last=state.model.receiptLog.receipts.at(-1);await request(root+'/receipts','POST',{revision:state.revision,action:'review',receiptId:last.id,review:review(state.model,'B',true)});
 await panel.getByRole('button',{name:'重新生成输出',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-testid="output-conclusion"]')?.textContent.includes('当前结论：F'));await copy('output-report','复制等待或结束回执');
 const closed=await request(root+'/monitor');state=await request(root+'/model');await request(root+'/receipts','POST',{revision:state.revision,action:'invalidate',reviewId:state.model.receiptLog.reviews.at(-1).id,reason:'证据失效'});
 await panel.getByRole('button',{name:'重新生成输出',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-testid="output-conclusion"]')?.textContent.includes('当前结论：B'));assert.equal(await panel.getByTestId('output-report').count(),0);assert.deepEqual((await request(root+'/monitor')).lifecycle.closures,closed.lifecycle.closures);
 // Version switch: raw text, original/current goals, criteria and station heads remain separate.
 saved=await request(root+'/model');const originalSource=saved.model.plans[0].source;
 saved.model.plans.push({...saved.model.plans[0],id:'V2',previousId:'V',version:'2.0',goal:'修订项目目标',acceptance:['新版项目验收'],source:'日期：2026-11-08\n状态：待核验\n# 修订原文',impact:'验收与站点变化，影响待核验'});saved.model.currentPlanId='V2';saved.model.stations.forEach(s=>s.planId='V2');saved.model.stations[1].title='修订验收目标';saved.model.stations[1].acceptance.push('新版站点验收');await request(root+'/model','PUT',saved);
 await panel.getByRole('button',{name:'重新生成输出',exact:true}).click();await panel.getByText('当前方案：2.0',{exact:true}).waitFor();assert.match(await panel.textContent(),/原始项目目标/);assert.match(await panel.textContent(),/修订项目目标/);assert.match(await panel.textContent(),/符合当前方案：待核验/);
 await panel.getByText('初始方案原文',{exact:true}).click();assert.equal(await panel.getByTestId('plan-initial-source').textContent(),originalSource);await panel.getByText('当前方案原文',{exact:true}).click();assert.match(await panel.getByTestId('plan-current-source').textContent(),/修订原文/);
 await panel.getByText('关联站点目标、范围、验收与依赖差异',{exact:true}).click();assert.match(await panel.getByTestId('plan-station-diff').textContent(),/新版站点验收/);assert.match(await panel.getByTestId('plan-station-diff').textContent(),/完成既定验收/);
 const v2=await copy('output-execution-0','复制执行指令 1');assert.match(v2,/版本 2.0/);assert.match(v2,/修订验收目标/);
 await mkdir('test-results',{recursive:true});await panel.screenshot({path:'test-results/m05-outputs.png'});
 // Switching projects remounts the generator, never copying the former project.
 const p2=(await request('/api/projects','POST',{name:'第二个隔离项目',goal:'另一个项目',steps:[]})).project,root2=`/api/projects/${p2.id}`;saved=await request(root2+'/model');saved.model=model();saved.model.chats[0].repository='G:\\second-project';delete saved.model.folders[0].externalId;await request(root2+'/model','PUT',saved);
 await page.reload();await page.evaluate(()=>{const write=navigator.clipboard.writeText.bind(navigator.clipboard);navigator.clipboard.writeText=async text=>{window.lastClipboardInput=text;return write(text);};});await page.getByRole('button').filter({hasText:'第二个隔离项目'}).click();await conclusion.waitFor();const other=await copy('output-execution-0','复制执行指令 1');assert.match(other,/第二个隔离项目/);assert.match(other,/G:\\second-project/);assert.doesNotMatch(other,/M05浏览器独立项目/);assert.match(other,/项目标识：待核实/);assert.match(await panel.textContent(),/Codex 项目标识待核实/);
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'收起 AI 助手',exact:true}).click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);await panel.screenshot({path:'test-results/m05-mobile.png'});assert.deepEqual(errors,[]);
 assert.deepEqual(await Promise.all([readFile(archive,'utf8'),readFile(initialPlan,'utf8')]),originals);
 console.log('PASS M05 浏览器：预览与真实剪贴板一致、站点/项目/方案切换、过期拒绝、复制失败反馈、E/F结束句、旧关闭待复核、双版本原文/目标/验收/站点差异、缺失身份及手机布局；无浏览器异常');
}finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await rm(dataDir,{recursive:true,force:true});}
