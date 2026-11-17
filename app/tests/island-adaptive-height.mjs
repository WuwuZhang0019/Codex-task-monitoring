// 日期：2026-11-17。隔离浏览器验证内容高度、屏幕上限和原有侧边滚动，不写正式业务数据。
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from '@playwright/test';

const shell=process.env.ISLAND_SHELL_ROOT;
if(!shell||!process.env.ISLAND_HEIGHT_SNAPSHOT)throw Error('Set ISLAND_SHELL_ROOT and ISLAND_HEIGHT_SNAPSHOT');
const original=JSON.parse(await readFile(process.env.ISLAND_HEIGHT_SNAPSHOT,'utf8'));
const output=path.resolve('test-results/adaptive-height');await mkdir(output,{recursive:true});
const {preview}=await import(pathToFileURL(path.join(shell,'node_modules/vite/dist/node/index.js')));
const server=await preview({root:shell,configFile:false,preview:{host:'127.0.0.1',port:1496,strictPort:true}});
let snapshot=original,preferences={collapsed:[],selected:original.steps[0].key,focus:[],scroll:{},y:{}};
const report={date:'2026-11-17',native:false,checks:[],sizes:[],errors:[]};
function fixture(count){
 const s=structuredClone(original),root=s.steps.find(step=>step.parentKey===null),plan=s.plans[0];
 s.steps=Array.from({length:count},(_,i)=>({...root,key:'height-fixture/'+i,id:'height-fixture-'+i,code:'X'+i,title:'隔离显示线路 '+i,parentKey:null,order:i+1,dependsOn:[],status:'pending',acceptance:'pending',conditions:root.conditions.map(c=>({...c,result:'pending',evidenceIds:[]})),evidence:[],blockers:[],bindingKey:null,executionKey:null}));
 plan.stageCount=count;plan.stageKeys=s.steps.map(step=>step.key);
 s.routes=s.steps.map((step,i)=>({...s.routes[0],key:'height-route/'+i,id:'height-route-'+i,stepKeys:[step.key],order:i+1,sourceStepKey:null,returnStepKey:null}));
 for(const name of ['bindings','executions','events','supplements'])s[name]=[];
 s.uiPreferences={collapsedKeys:[],selectedStepKey:null,focusedRouteKey:null,scrollByProject:{}};
 return s;
}
function twoTasks(count=2){
 const s=structuredClone(original),tiny=fixture(1),project='height-fixture-project',plan='height-fixture-plan';
 tiny.projects[0]={...tiny.projects[0],key:project,id:project,name:'隔离简单任务',planKeys:[plan]};
 tiny.plans[0]={...tiny.plans[0],key:plan,id:plan,projectKey:project,name:'隔离简单任务'};
 for(const item of [...tiny.steps,...tiny.routes]){item.projectKey=project;item.planKey=plan;}
 for(const group of ['projects','plans','steps','routes'])s[group].push(...tiny[group]);
 if(count===3){
  const extra=structuredClone(tiny),suffix='/third';
  for(const group of ['projects','plans','steps','routes'])for(const item of extra[group]){item.key+=suffix;item.id+=suffix;if(item.projectKey)item.projectKey+=suffix;if(item.planKey)item.planKey+=suffix;}
  extra.projects[0].planKeys=extra.projects[0].planKeys.map(key=>key+suffix);
  extra.plans[0].stageKeys=extra.plans[0].stageKeys.map(key=>key+suffix);
  extra.routes[0].stepKeys=extra.routes[0].stepKeys.map(key=>key+suffix);
  for(const group of ['projects','plans','steps','routes'])s[group].push(...extra[group]);
 }
 return s;
}
let browser,page;
try{
 browser=await chromium.launch({headless:true,channel:'msedge'});
 async function settled(){
  await page.evaluate(async()=>{window.__heightSettlement=null;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
  await page.waitForFunction(()=>{
   const root=document.querySelector('[data-expanded-content]'),shell=document.querySelector('[data-hit]'),target=Number(root?.dataset.contentHeight);
   if(!target||!shell||Math.abs(shell.getBoundingClientRect().height-target)>=0.25){window.__heightSettlement=null;return false;}
   const state=window.__heightSettlement;
   window.__heightSettlement={target,frames:state?.target===target?state.frames+1:1};return window.__heightSettlement.frames>=4;
  });
  await page.waitForTimeout(200);
 }
 async function metrics(){return page.evaluate(()=>{
  const shell=document.querySelector('[data-hit]'),list=document.querySelector('[data-workbench-routes]'),cards=[...document.querySelectorAll('[data-route-card]')];
  const rect=shell.getBoundingClientRect(),area=list.getBoundingClientRect();
  return {height:rect.height,top:rect.top,bottom:rect.bottom,viewport:innerHeight,scroll:list.scrollTop,scrollHeight:list.scrollHeight,listHeight:list.clientHeight,cardHeight:cards[0]?.offsetHeight,cardBottom:cards[0]?.getBoundingClientRect().bottom,listBottom:area.bottom};
 });}
 for(const style of ['windows','dynamic']){
  snapshot=original;preferences={collapsed:[],selected:original.steps[0].key,focus:[],scroll:{},y:{}};
  page=await browser.newPage({viewport:{width:1100,height:1200},locale:'zh-CN'});page.setDefaultTimeout(12000);
  page.on('pageerror',error=>report.errors.push(error.message));
  await page.addInitScript(value=>localStorage.setItem('island-workbench-settings-v1',JSON.stringify({'shell.configVersion':1,'app.language':'zh-CN','appearance.style':value,'island.openOn':'click','tasks.displaySize':'large','tasks.cardEffect':'minimal','appearance.tabsPosition':value==='windows'?'bottom':'top'})),style);
  await page.exposeBinding('heightBridge',async(_source,command,args)=>{
   if(command==='island_workbench_read')return {snapshot,preferences,library:{version:1,archived:[]}};
   if(command==='island_workbench_save_preferences'){preferences=args.value;return {saved:true};}
   throw Error('Unexpected display fixture command: '+command);
  });
  await page.goto('http://127.0.0.1:1496');await page.locator('[data-workbench-summary]').waitFor();
  await page.evaluate(()=>{window.__TAURI_INTERNALS__={invoke:(command,args)=>window.heightBridge(command,args)};});
  await page.waitForFunction(()=>document.querySelector('[data-workbench-summary]')?.getAttribute('data-connection')==='ready');
  await page.locator('[data-hit]').click();await page.getByTitle('固定展开',{exact:true}).click();await settled();
  const tall=await metrics();report.sizes.push({style,case:'actual-readonly-project',...tall});
  assert.ok(tall.height>560,JSON.stringify(tall));assert.ok(tall.bottom<=1200-40);assert.ok(tall.cardBottom<=tall.listBottom+1,'all project lanes fit when screen space permits');
  await page.screenshot({path:path.join(output,style+'-full-project.png')});
  report.checks.push(style+': full project grows past old fixed ceiling and keeps every lane visible');
  const lane=page.locator('[data-route-card] .wb-lane').first();
  assert.ok(await lane.evaluate(element=>element.scrollWidth>element.clientWidth),'readonly project provides an overflowing route for horizontal wheel verification');
  const laneBox=await lane.boundingBox(),outerBefore=(await metrics()).scroll;await page.mouse.move(laneBox.x+120,laneBox.y+40);await page.mouse.wheel(0,240);await page.waitForTimeout(200);
  assert.ok(await lane.evaluate(element=>element.scrollLeft>0),'wheel inside a route still scrolls horizontally');assert.equal((await metrics()).scroll,outerBefore,'graph scrolling must not page the task list');
  await lane.evaluate(element=>{element.scrollLeft=0;});
  report.checks.push(style+': graph wheel remains horizontal and does not page tasks');
  await page.getByTitle('切换为紧凑列表',{exact:true}).click();await settled();const compact=await metrics();
  assert.ok(compact.height<tall.height-100);assert.ok(Math.abs(compact.top-tall.top)<1);
  await page.getByTitle('切换为完整卡片',{exact:true}).click();await settled();assert.ok((await metrics()).height>compact.height+100);
  report.checks.push(style+': small/large display changes height without moving the top edge');
  snapshot=fixture(1);await page.waitForFunction(()=>document.querySelectorAll('[data-route-card] .wb-route-body [data-step-key]').length===1);await settled();const simple=await metrics();
  assert.ok(simple.height<tall.height-150);assert.ok(Math.abs(simple.top-tall.top)<1);report.sizes.push({style,case:'simple-task',...simple});
  report.checks.push(style+': a simple task contracts the shell instead of retaining empty height');
  snapshot=twoTasks();await page.waitForFunction(()=>document.querySelectorAll('[data-route-card]').length===2);await settled();
  const side=await page.locator('[data-workbench-routes]').boundingBox();await page.mouse.move(side.x+side.width+4,side.y+40);await page.mouse.wheel(0,120);
  const movement=await page.evaluate(async()=>{
   const samples=[];
   for(let i=0;i<36;i++){samples.push({scroll:document.querySelector('[data-workbench-routes]').scrollTop,height:document.querySelector('[data-hit]').getBoundingClientRect().height});await new Promise(requestAnimationFrame);}
   return samples;
  });
  const distance=movement.at(-1).scroll;
  assert.ok(distance>100,'one ordinary wheel detent reaches the next task');
  assert.ok(movement.filter(sample=>sample.scroll>1&&sample.scroll<distance-1).length>=4,'task paging must pass through intermediate positions');
  assert.ok(Math.max(...movement.slice(1).map((sample,i)=>Math.abs(sample.scroll-movement[i].scroll)))<distance*0.6,'paging must not snap at the height transition');
  report.sizes.push({style,case:'side-wheel-animation',samples:movement});
  await page.waitForFunction(()=>Number(document.querySelector('[data-expanded-content]')?.getAttribute('data-content-height'))<500);await settled();
  assert.ok((await metrics()).scroll>0);
  await page.setViewportSize({width:1100,height:900});await settled();assert.ok((await metrics()).height<500,'screen changes retain the currently viewed simple task');
  await page.setViewportSize({width:1100,height:1200});await settled();assert.ok((await metrics()).height<500);
  const lastTop=(await metrics()).scroll;await page.mouse.wheel(0,120);await page.waitForTimeout(450);assert.ok(Math.abs((await metrics()).scroll-lastTop)<=1,'last task is a stable boundary');
  await page.mouse.move(side.x+side.width+4,side.y+30);await page.mouse.wheel(0,-120);
  await page.waitForFunction(()=>Number(document.querySelector('[data-expanded-content]')?.getAttribute('data-content-height'))>560);await settled();
  assert.ok((await metrics()).scroll<=1);
  report.checks.push(style+': side scrolling to a different task resizes and preserves its reading anchor');
  report.checks.push(style+': one wheel detent smoothly pages exactly one task through the right gutter');
  await page.mouse.wheel(0,-120);await page.waitForTimeout(450);assert.ok((await metrics()).scroll<=1,'first task is a stable boundary');
  await page.mouse.wheel(0,120);await page.waitForTimeout(90);await page.mouse.wheel(0,-120);await page.waitForTimeout(600);await settled();
  assert.ok((await metrics()).scroll<=1,'reverse wheel interrupts the animation without a stale final snap');
  assert.ok((await metrics()).height>560);
  report.checks.push(style+': quick reversal and first/last task boundaries remain stable');
  snapshot=twoTasks(3);await page.waitForFunction(()=>document.querySelectorAll('[data-route-card]').length===3);await settled();
  const gutter=await page.locator('[data-workbench-routes]').boundingBox();await page.mouse.move(gutter.x+gutter.width+4,gutter.y+30);await page.mouse.wheel(0,120);await page.waitForTimeout(650);await settled();
  const middleTop=await page.locator('[data-route-card]').nth(1).evaluate(card=>card.getBoundingClientRect().top-document.querySelector('[data-workbench-routes]').getBoundingClientRect().top);
  assert.ok(Math.abs(middleTop-10)<=2,'one detent lands on the middle task without skipping to the last');
  await page.mouse.wheel(0,120);await page.waitForTimeout(650);await settled();
  const thirdTop=await page.locator('[data-route-card]').nth(2).evaluate(card=>card.getBoundingClientRect().top-document.querySelector('[data-workbench-routes]').getBoundingClientRect().top);
  assert.ok(Math.abs(thirdTop-10)<=2,'the next detent advances by one more task');
  report.checks.push(style+': successive detents visit the middle and last tasks without skipping');
  await page.emulateMedia({reducedMotion:'reduce'});await page.mouse.wheel(0,-120);await page.waitForTimeout(650);await settled();await page.mouse.wheel(0,-120);await page.waitForTimeout(650);await settled();
  assert.ok((await metrics()).scroll<=1,'reduced motion still aligns the first task after its height grows');
  await page.mouse.wheel(0,120);await page.waitForTimeout(650);await settled();
  assert.ok(Math.abs(await page.locator('[data-route-card]').nth(1).evaluate(card=>card.getBoundingClientRect().top-document.querySelector('[data-workbench-routes]').getBoundingClientRect().top)-10)<=2,'reduced motion still aligns the next task after its height shrinks');
  await page.emulateMedia({reducedMotion:'no-preference'});
  report.checks.push(style+': reduced motion preserves the task anchor across height changes');
  snapshot=fixture(24);
  const animationBottom=await page.evaluate(async()=>{const values=[];for(let i=0;i<120;i++){values.push(document.querySelector('[data-hit]').getBoundingClientRect().bottom);await new Promise(requestAnimationFrame);}return Math.max(...values);});
  assert.ok(animationBottom<=1200-40,'height animation must not overshoot the available screen area');
  await page.waitForFunction(()=>document.querySelectorAll('[data-route-card] .wb-route-body [data-step-key]').length===24);await settled();const huge=await metrics();
  assert.ok(huge.bottom<=1200-40);assert.ok(huge.scrollHeight>huge.listHeight+500);
  const list=await page.locator('[data-workbench-routes]').boundingBox();await page.mouse.move(list.x+2,list.y+list.height/2);await page.mouse.wheel(0,600);
  await page.waitForFunction(()=>document.querySelector('[data-workbench-routes]').scrollTop>100);await settled();
  report.checks.push(style+': screen-height cap preserves existing side wheel vertical scrolling');
  await page.setViewportSize({width:1100,height:620});
  await page.waitForFunction(()=>Number(document.querySelector('[data-expanded-content]')?.getAttribute('data-content-height'))<=innerHeight-48);
  assert.ok((await metrics()).bottom<=620-40,'the actual frame is capped immediately while the old height animation settles');
  await settled();const short=await metrics();assert.ok(short.bottom<=620-40);report.sizes.push({style,case:'short-screen',...short});
  await page.setViewportSize({width:1100,height:1200});await settled();assert.ok((await metrics()).height>short.height+400);
  report.checks.push(style+': resizing the available screen updates the cap in both directions');
  const samples=[];for(let i=0;i<6;i++){samples.push((await metrics()).height);await page.waitForTimeout(100);}
  assert.ok(Math.max(...samples)-Math.min(...samples)<2,'content measurement must not feed back into shell height');
  report.checks.push(style+': settled height does not oscillate');
  await page.close();
 }
 assert.deepEqual(report.errors,[]);await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}catch(error){
 if(page&&!page.isClosed()){report.failureMetrics=await page.evaluate(()=>({height:document.querySelector('[data-hit]')?.getBoundingClientRect().height,target:document.querySelector('[data-expanded-content]')?.getAttribute('data-content-height'),scroll:document.querySelector('[data-workbench-routes]')?.scrollTop})).catch(()=>null);await page.screenshot({path:path.join(output,'failure.png')});}
 report.failure=String(error.stack??error);await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');throw error;
}finally{await browser?.close();await new Promise(resolve=>server.httpServer.close(resolve));}
