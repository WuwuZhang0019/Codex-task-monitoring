import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from '@playwright/test';
import {createServer} from '../server/index.mjs';
const dataDir=await mkdtemp(path.join(tmpdir(),'m02-ui-'));
let server,browser;
async function start(){server=await createServer({dataDir,env:{}});await new Promise(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${server.address().port}`;}
async function stop(){if(server){server.closeAllConnections();await new Promise(r=>server.close(r));server=null;}}
try{
 let base=await start();
 const original={name:'M02隔离验收',goal:'保存关系',source:'原始方案',steps:[{id:'M01',title:'站点',line:'主线',purpose:'原范围',sourceExcerpt:'原始方案',dependsOn:[],acceptance:['核对'],status:'done',summary:'旧手动完成',nextAction:'',blocker:'',evidence:'旧引用'}]};
 const p=await fetch(base+'/api/projects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(original)}).then(r=>r.json());
 browser=await chromium.launch({headless:true});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.getByRole('button',{name:'管理任务与方案版本'}).click();
 await page.getByRole('button',{name:'添加文件夹',exact:true}).click();await page.locator('[aria-label$=" 文件夹名称"]').fill('测试文件夹');
 await page.locator('[aria-label$=" 唯一所属文件夹"]').selectOption({label:'测试文件夹'});
 await page.getByRole('button',{name:'添加聊天来源',exact:true}).click();await page.locator('[aria-label$=" 聊天标识（可待绑定）"]').last().fill('chat-one');
 await page.getByRole('button',{name:'添加聊天来源',exact:true}).click();await page.locator('[aria-label$=" 聊天标识（可待绑定）"]').last().fill('chat-two');
 await page.getByRole('button',{name:'添加方案版本',exact:true}).click();await page.locator('[aria-label$=" 版本号"]').fill('1.0');
 await page.getByLabel('初始方案',{exact:true}).selectOption({label:'1.0'});await page.getByLabel('当前方案',{exact:true}).selectOption({label:'1.0'});
 await page.getByRole('button',{name:'保存任务关系',exact:true}).click();await page.getByText('关系与方案版本已保存，验收状态仍为待核验。',{exact:true}).waitFor();
 const endpoint=`/api/projects/${p.project.id}/model`;const saved=await fetch(base+endpoint).then(r=>r.json());
 assert.equal(saved.model.chats.length,2);assert.equal(saved.model.stations[0].verification,'pending');assert.equal(saved.model.stations[0].report.status,'done');
 assert.equal(await page.locator('[aria-label$=" 唯一所属文件夹"]').isDisabled(),true);
 await stop();base=await start();await page.goto(base);await page.getByRole('button',{name:'管理任务与方案版本'}).click();await page.locator('[aria-label$=" 文件夹名称"]').waitFor();
 assert.equal(await page.locator('[aria-label$=" 文件夹名称"]').inputValue(),'测试文件夹');assert.equal(await page.locator('[aria-label$=" 聊天标识（可待绑定）"]').count(),2);
 assert.deepEqual(await fetch(base+endpoint).then(r=>r.json()),saved);assert.deepEqual(errors,[]);
 await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/m02-relations.png',fullPage:true});
 console.log('PASS M02 管理界面保存、冷重开、双聊天延续、绑定保护、旧完成待核验与无浏览器异常');
}finally{await browser?.close();await stop();await rm(dataDir,{recursive:true,force:true});}
