// 日期：2026-11-12。隔离复核Esc后悬停重开，不修改产品源码。
import {chromium} from 'playwright';import {writeFile} from 'node:fs/promises';
const b=await chromium.connectOverCDP('http://127.0.0.1:19226',{noDefaults:true});let p;
for(const q of b.contexts().flatMap(c=>c.pages()))if(await q.locator('[data-workbench-summary],[data-workbench]').count())p=q;
p.setDefaultTimeout(5000);const inv=(cmd,args)=>p.evaluate(({cmd,args})=>window.__TAURI_INTERNALS__.invoke(cmd,args),{cmd,args});
const h=v=>inv('plugin:event|emit',{event:'island://hover',payload:v});
const snap=()=>p.evaluate(()=>({visibility:document.visibilityState,focus:document.hasFocus(),activeTag:document.activeElement?.tagName,activeText:document.activeElement?.tagName==='BUTTON'?document.activeElement?.textContent?.slice(0,40):'',wb:!!document.querySelector('[data-workbench]'),rect:document.querySelector('[data-hit]')?.getBoundingClientRect().toJSON()}));
const r={date:'2026-11-12',cycles:[]};
for(let i=0;i<2;i++){
 await h(false);await p.waitForTimeout(1500);await h(true);await p.waitForTimeout(1800);
 const a=await snap();
 if(a.wb){await inv('focus_island');await p.getByRole('button',{name:'定位当前',exact:true}).focus();await p.keyboard.press('Enter');await p.getByRole('button',{name:'刷新',exact:true}).focus();await p.keyboard.press('Tab');}
 const before=await snap();await p.keyboard.press('Escape');await h(false);await p.waitForTimeout(1200);const after=await snap();await h(true);await p.waitForTimeout(2500);const reopen=await snap();
 r.cycles.push({before,after,reopen});
}
await writeFile('G:/rust/Codex-task-monitoring/docs/03_轻量路线工作台/06_执行记录/island-workbench-20261111/assets/E/continuation/escape-reopen-probe_2026-11-12.json',JSON.stringify(r,null,2));console.log(JSON.stringify(r));process.exit(0);
