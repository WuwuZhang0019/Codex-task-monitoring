// 日期：2026-11-08。慢供应商回放，隔离生产UI导入，不请求真实服务。
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {createServer} from '../server/index.mjs';
import {planSteps} from '../server/plan-steps.mjs';
const out=path.resolve('test-results/ai-import');await mkdir(out,{recursive:true});
const dataDir=await mkdtemp(path.join(out,'isolated-'));
const source=await readFile('../docs/99_归档/2026-11-10_旧路线/01_任务监测工作台_v1.0/01_执行方案/01_Codex任务状态监测工作台_可执行方案_2026-11-08.md','utf8');
const result=process.env.AI_REPLAY_FILE?JSON.parse(await readFile(process.env.AI_REPLAY_FILE,'utf8')):{name:'隔离导入',goal:'验证六步预览',warnings:[],steps:planSteps({source}).map((s,i,a)=>({id:s.code,title:s.title,line:'主线',purpose:s.title,sourceExcerpt:s.title,dependsOn:i?[a[i-1].code]:[],acceptance:['待人工确认：回放仅检查导入'],status:'todo',summary:'',nextAction:'',blocker:'',evidence:''}))};
let server,browser;
try{
 server=await createServer({dataDir,env:{OPENAI_API_KEY:'isolated'},fetchImpl:async()=>{await new Promise(r=>setTimeout(r,31000));return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByRole('button',{name:'新建项目',exact:true}).first().click();await page.getByRole('dialog').getByLabel('项目名称',{exact:true}).fill('慢模型导入隔离');await page.getByRole('button',{name:'创建项目',exact:true}).click();
 await page.getByRole('button',{name:'导入方案',exact:true}).click();await page.getByLabel('执行方案文本',{exact:true}).fill(source);const start=Date.now();await page.getByRole('button',{name:'发送并提取路线'}).click();await page.getByLabel('站点 6 编号',{exact:true}).waitFor({timeout:45000});
 assert.equal(await page.getByLabel('站点 6 编号',{exact:true}).inputValue(),'M06');assert.equal(await page.getByRole('button',{name:'确认并生成路线'}).isDisabled(),true);assert.deepEqual(errors,[]);
 await page.getByRole('dialog').screenshot({path:path.join(out,'slow-preview.png')});await writeFile(path.join(out,'ui-result.json'),JSON.stringify({date:'2026-11-08',passed:true,elapsedMs:Date.now()-start,codes:result.steps.map(s=>s.id),realServiceReplay:!!process.env.AI_REPLAY_FILE,confirmationRequired:true},null,2));console.log('PASS 31秒慢响应经过HTTP和生产UI到六步待确认预览，未自动保存，未请求真实模型');
}finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}assert.equal(path.dirname(dataDir),out);await rm(dataDir,{recursive:true,force:true});}
