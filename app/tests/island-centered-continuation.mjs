// Date: 2026-11-17. Verify the screenshot's many-to-one layout with an isolated readonly bridge.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from '@playwright/test';

const shell=process.env.ISLAND_SHELL_ROOT;
if(!shell||!process.env.ISLAND_CENTER_SNAPSHOT)throw Error('Set ISLAND_SHELL_ROOT and ISLAND_CENTER_SNAPSHOT');
const snapshot=JSON.parse(await readFile(process.env.ISLAND_CENTER_SNAPSHOT,'utf8'));
const output=path.resolve('test-results/centered-continuation');await mkdir(output,{recursive:true});
const {preview}=await import(pathToFileURL(path.join(shell,'node_modules/vite/dist/node/index.js')));
const server=await preview({root:shell,configFile:false,preview:{host:'127.0.0.1',port:1497,strictPort:true}});
const report={date:'2026-11-17',native:false,checks:[],sizes:[],errors:[]};
const codes=Object.fromEntries(snapshot.steps.map(step=>[step.code,step.key]));
let browser,page;
try{
 browser=await chromium.launch({headless:true,channel:'msedge'});
 for(const style of ['windows','dynamic'])for(const width of [1100,480]){
  let preferences={collapsed:[],selected:codes.E,focus:[],scroll:{},y:{}};
  page=await browser.newPage({viewport:{width,height:900},locale:'zh-CN'});page.setDefaultTimeout(10000);
  page.on('pageerror',error=>report.errors.push(error.message));
  await page.addInitScript(value=>localStorage.setItem('island-workbench-settings-v1',JSON.stringify({'shell.configVersion':1,'app.language':'zh-CN','appearance.style':value,'island.openOn':'click','tasks.displaySize':'large','tasks.cardEffect':'minimal','appearance.tabsPosition':value==='windows'?'bottom':'top'})),style);
  await page.exposeBinding('centerBridge',async(_source,command,args)=>{
   if(command==='island_workbench_read')return {snapshot,preferences,library:{version:1,archived:[]}};
   if(command==='island_workbench_save_preferences'){preferences=args.value;return {saved:true};}
   throw Error('Unexpected display command: '+command);
  });
  await page.goto('http://127.0.0.1:1497');await page.locator('[data-workbench-summary]').waitFor();
  await page.evaluate(()=>{window.__TAURI_INTERNALS__={invoke:(command,args)=>window.centerBridge(command,args)};});
  await page.waitForFunction(()=>document.querySelector('[data-workbench-summary]')?.getAttribute('data-connection')==='ready');
  await page.locator('[data-hit]').click();await page.getByTitle('固定展开',{exact:true}).click();
  for(const compact of [false,true]){
   if(compact)await page.getByTitle('切换为紧凑列表',{exact:true}).click();
   await page.waitForTimeout(700);
   const graph=page.locator(compact?'.wb-row-thumbnail .wb-group-graph':'.wb-route-body .wb-group-graph').first();
   const result=await graph.evaluate((element,keys)=>{
    const y=code=>{const dot=[...element.querySelectorAll('[data-step-key]')].find(node=>node.dataset.stepKey===keys[code]).querySelector('.wb-dot').getBoundingClientRect();return dot.y+dot.height/2;};
    const preceding=['A','C','G'].map(y),continuation=['E','F','I','J'].map(y),svg=element.querySelector('svg'),matrix=svg.getScreenCTM(),errors=[];
    for(const edge of svg.querySelectorAll('path[data-from]'))for(const [key,point] of [[edge.dataset.from,edge.getPointAtLength(0)],[edge.dataset.to,edge.getPointAtLength(edge.getTotalLength())]]){
     const dot=[...element.querySelectorAll('[data-step-key]')].find(node=>node.dataset.stepKey===key).querySelector('.wb-dot').getBoundingClientRect();
     const screen=new DOMPoint(point.x,point.y).matrixTransform(matrix),distance=Math.hypot(screen.x-dot.x-dot.width/2,screen.y-dot.y-dot.height/2);if(distance>1.2)errors.push({key,distance});
    }
    return {preceding,continuation,height:element.getBoundingClientRect().height,nodes:element.querySelectorAll('[data-step-key]').length,errors};
   },codes);
   const middle=(Math.min(...result.preceding)+Math.max(...result.preceding))/2;
   for(const y of result.continuation)assert.ok(Math.abs(y-middle)<=1,JSON.stringify(result));
   assert.equal(result.nodes,10);assert.deepEqual(result.errors,[]);assert.equal(result.height,compact?60:284);
   report.checks.push(`${style}/${width}/${compact?'compact':'full'}: E/F/I/J centered between A/C/G; all ten stations and curve endpoints preserved`);
   report.sizes.push({style,width,compact,...result});
   await page.screenshot({path:path.join(output,`${style}-${width}-${compact?'compact':'full'}.png`)});
   if(width===1100&&!compact)await page.locator('[data-route-card]').first().screenshot({path:path.join(output,`${style}-centered-card.png`)});
  }
  await page.close();
 }
 assert.deepEqual(report.errors,[]);
}catch(error){report.failure=String(error.stack??error);if(page&&!page.isClosed())await page.screenshot({path:path.join(output,'failure.png')});throw error;}
finally{await browser?.close();await new Promise(resolve=>server.httpServer.close(resolve));await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({checks:report.checks.length,errors:report.errors}));
