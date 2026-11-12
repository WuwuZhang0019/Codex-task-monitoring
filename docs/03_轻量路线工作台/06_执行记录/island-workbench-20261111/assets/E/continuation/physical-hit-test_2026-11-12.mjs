// 日期：2026-11-12。真实OS指针保持不动，用正常UI几何变化验证native hit-test；不发hover事件。
import assert from 'node:assert/strict';import {chromium} from 'playwright';import {spawnSync} from 'node:child_process';import {writeFile} from 'node:fs/promises';
const b=await chromium.connectOverCDP('http://127.0.0.1:19226',{noDefaults:true});let p;
for(const q of b.contexts().flatMap(c=>c.pages()))if(await q.locator('[data-workbench-summary],[data-workbench]').count())p=q;
p.setDefaultTimeout(6000);
const probe=()=>JSON.parse(spawnSync('pwsh',['-NoProfile','-File','G:/rust/Codex-task-monitoring/app/test-results/island-E/continuation/read-native-state.ps1','-IslandHandle','2428054','-SettingsHandle','39390414'],{encoding:'utf8',windowsHide:true}).stdout.trim());
const r={date:'2026-11-12',nativeInstalled:true,method:'Sky coordinate click positions actual OS cursor in compact-outside/expanded-inside area; CDP normal click/Esc changes actual shell geometry; only listen to native hover events, no hover event injection',cycles:[]};
try{
 r.before=probe();const scale=r.before.island.dpi/96;const point={x:(r.before.cursor.x-r.before.island.rect.left)/scale,y:(r.before.cursor.y-r.before.island.rect.top)/scale};
 const compact=await p.locator('[data-hit]').boundingBox();assert.ok(point.y>compact.y+compact.height);
 const initial=await p.evaluate(()=>window.__EObservedHover.length);
 for(let i=0;i<3;i++){
  const start=await p.evaluate(()=>window.__EObservedHover.length);
  await p.locator('[data-hit]').click({position:{x:35,y:18}});await p.waitForTimeout(1000);
  const expanded=await p.locator('[data-hit]').boundingBox();assert.ok(point.x>=expanded.x&&point.x<expanded.x+expanded.width&&point.y>=expanded.y&&point.y<expanded.y+expanded.height);
  const enter=await p.evaluate(start=>window.__EObservedHover.slice(start),start);assert.ok(enter.some(e=>e.inside===true),'native enter must be observed');
  const during=probe();assert.equal(during.cursor.x,r.before.cursor.x);assert.equal(during.cursor.y,r.before.cursor.y);assert.equal(during.island.transparent,false,'native window must stop ignoring mouse inside shape');
  await p.keyboard.press('Escape');await p.waitForTimeout(1500);
  const events=await p.evaluate(start=>window.__EObservedHover.slice(start),start);assert.ok(events.some(e=>e.inside===false),'native leave must be observed after shrink');
  const after=probe();assert.equal(after.island.transparent,true);assert.ok((await p.locator('[data-hit]').boundingBox()).height<60);
  r.cycles.push({expanded,events,during,after});
 }
 r.passed=true;
}catch(e){r.passed=false;r.error=String(e.stack);}finally{
 r.allObserved=await p.evaluate(()=>window.__EObservedHover);await p.keyboard.press('Escape').catch(()=>{});
 await writeFile('G:/rust/Codex-task-monitoring/docs/03_轻量路线工作台/06_执行记录/island-workbench-20261111/assets/E/continuation/physical-hit-test_2026-11-12.json',JSON.stringify(r,null,2));console.log(JSON.stringify({passed:r.passed,cycles:r.cycles.length,error:r.error,events:r.allObserved}));process.exit(r.passed?0:1);
}
