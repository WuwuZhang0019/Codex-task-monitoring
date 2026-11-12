// 日期：2026-11-12。只读监听真实原生命中线程；不发送悬停事件、不注入OS输入。
import {chromium} from 'playwright';import {writeFile} from 'node:fs/promises';
const b=await chromium.connectOverCDP('http://127.0.0.1:19226',{noDefaults:true});let p;
for(const q of b.contexts().flatMap(c=>c.pages()))if(await q.locator('[data-workbench-summary],[data-workbench]').count())p=q;
await p.keyboard.press('Escape');await p.waitForTimeout(1500);
await p.evaluate(async()=>{
 window.__EObservedHover=[];
 const handler=window.__TAURI_INTERNALS__.transformCallback(e=>window.__EObservedHover.push({inside:e.payload,at:Date.now()}));
 window.__EHoverListenerId=await window.__TAURI_INTERNALS__.invoke('plugin:event|listen',{event:'island://hover',target:{kind:'Any'},handler});
});
console.log(JSON.stringify({shell:await p.locator('[data-hit]').boundingBox(),listening:true}));process.exit(0);
