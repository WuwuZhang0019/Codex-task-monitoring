import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {createServer} from '../server/index.mjs';
const dataDir=await mkdtemp(path.join(tmpdir(),'m03-ui-'));let server,browser;
async function start(){server=await createServer({dataDir,env:{}});await new Promise(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${server.address().port}`;}
async function stop(){if(server){server.closeAllConnections();await new Promise(r=>server.close(r));server=null;}}
try{
 let base=await start();
 async function request(url,method='GET',body){const res=await fetch(base+url,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});assert.equal(res.ok,true,await res.clone().text());return res.json();}
 const {project:p}=await request('/api/projects','POST',{name:'M03隔离验收',goal:'验证回执',steps:[]});
 const endpoint=`/api/projects/${p.id}`;const saved=await request(endpoint+'/model');
 const model=saved.model;model.tasks=[{id:'T',name:'任务',folderId:'F',acceptance:['任务交付'],handoff:'集成线'}];model.folders=[{id:'F'}];model.chats=[{id:'C',taskId:'T',folderId:'F'}];model.plans=[{id:'V',version:'1',source:'基线',previousId:null}];model.initialPlanId='V';model.currentPlanId='V';model.acceptance=['项目组合验收'];model.stations=[{id:'S',taskId:'T',code:'S01',title:'实现与验证',scope:'固定范围',planId:'V',acceptance:['测试通过'],dependsOn:[],successors:[]}];
 await request(endpoint+'/model','PUT',saved);
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.getByRole('button',{name:'回执与头尾核验',exact:true}).click();await page.getByLabel('回执站点',{exact:true}).selectOption('S');
 const receipt=JSON.parse(await page.getByLabel('待导入回执',{exact:true}).inputValue());receipt.deliveryVersion='commit1';receipt.raw='日期：2026-11-08\n本站已完成，等待核验';receipt.actual='实现和隔离报告';
 await page.getByLabel('待导入回执',{exact:true}).fill(JSON.stringify(receipt));await page.getByRole('button',{name:'导入回执',exact:true}).click();await page.getByText('B · 尚无独立核验',{exact:true}).waitFor();
 let data=await request(endpoint+'/receipts');assert.equal(data.log.receipts.length,1);
 await page.getByRole('button',{name:'导入回执',exact:true}).click();await page.waitForTimeout(150);assert.equal((await request(endpoint+'/receipts')).log.receipts.length,1);
 await page.getByLabel('选择历史回执',{exact:true}).selectOption(data.log.receipts[0].id);
 await page.getByLabel('核验人',{exact:true}).fill('浏览器隔离测试人工核验');await page.getByLabel('核验方法',{exact:true}).fill('核对报告内容、版本及结果');
 for(const group of ['checks','taskChecks']){
  await page.getByLabel(`${group}-0-结果`,{exact:true}).selectOption('passed');await page.getByLabel(`${group}-0-依据`,{exact:true}).fill('报告明确对应本项并通过');
  for(const [key,value] of Object.entries({location:'隔离报告.json',deliveryVersion:'commit1',method:'读取报告对照提交',reason:'文件可读且版本和结果匹配'}))await page.getByLabel(`${group}-0-${key}`,{exact:true}).fill(value);
  await page.getByLabel(`${group}-0-证据状态`,{exact:true}).selectOption('valid');
 }
 await page.getByRole('button',{name:'保存独立核验',exact:true}).click();await page.getByText(/E · 本任务线交付通过/).waitFor();
 data=await request(endpoint+'/receipts');assert.equal(data.results.S.conclusion,'E');assert.equal(data.log.reviews.length,1);
 await stop();base=await start();await page.goto(base);await page.getByRole('button',{name:'回执与头尾核验',exact:true}).click();await page.getByText(/E · 本任务线交付通过/).waitFor();assert.deepEqual(await request(endpoint+'/receipts'),data);
 await page.getByLabel('失效原因',{exact:true}).fill('测试证据撤回');await page.locator('details').filter({hasText:'标记本核验失效'}).first().locator('summary').click();await page.getByRole('button',{name:'标记本核验失效',exact:true}).first().click();await page.getByText(/B · 核验或证据已失效/).waitFor();
 data=await request(endpoint+'/receipts');assert.equal(data.log.reviews.length,1);assert.equal(data.log.invalidations.length,1);assert.deepEqual(errors,[]);
 const outputDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../test-results');await mkdir(outputDir,{recursive:true});await page.screenshot({path:path.join(outputDir,'m03-receipts.png'),fullPage:true});console.log('PASS M03 浏览器导入、重复幂等、证据人工核验、E 交付、冷重开及失效保留历史');
}finally{await browser?.close();await stop();await rm(dataDir,{recursive:true,force:true});}
