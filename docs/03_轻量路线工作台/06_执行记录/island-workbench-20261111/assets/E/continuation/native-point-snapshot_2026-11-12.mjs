// 日期：2026-11-12。只读汇总电脑工具动作之后的native OS与真实DOM状态。
import {chromium} from 'playwright';import {spawnSync} from 'node:child_process';import {writeFile} from 'node:fs/promises';
const label=process.argv[2];if(!/^[a-z0-9-]+$/.test(label))throw Error('LABEL');
const b=await chromium.connectOverCDP('http://127.0.0.1:19226',{noDefaults:true});let p;for(const q of b.contexts().flatMap(c=>c.pages()))if(await q.locator('[data-workbench-summary],[data-workbench]').count())p=q;
await p.waitForTimeout(900);
const os=JSON.parse(spawnSync('pwsh',['-NoProfile','-File','G:/rust/Codex-task-monitoring/app/test-results/island-E/continuation/read-native-state.ps1','-IslandHandle','2428054','-SettingsHandle','39390414'],{encoding:'utf8',windowsHide:true}).stdout.trim());
const dom=await p.evaluate(()=>({hits:[...document.querySelectorAll('[data-hit]')].map(e=>e.getBoundingClientRect().toJSON()),expanded:!!document.querySelector('[data-workbench]'),pinned:document.querySelector('[aria-label="取消固定"]')?.getAttribute('aria-pressed')??false,nativeHover:window.__EObservedHover??[]}));
const scale=os.island.dpi/96;const cursorCss={x:(os.cursor.x-os.island.rect.left)/scale,y:(os.cursor.y-os.island.rect.top)/scale};const pointInHit=dom.hits.some(r=>cursorCss.x>=r.x&&cursorCss.x<r.right&&cursorCss.y>=r.y&&cursorCss.y<r.bottom);
const report={date:'2026-11-12',label,input:'actual screenshot-region Computer Use mouse action; this sampler sends no input',os,dom,cursorCss,pointInHit};
await writeFile(`G:/rust/Codex-task-monitoring/docs/03_轻量路线工作台/06_执行记录/island-workbench-20261111/assets/E/continuation/${label}_2026-11-12.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({label,expanded:dom.expanded,pinned:dom.pinned,pointInHit,foreground:os.foreground.handle,under:os.underCursor.handle,cursor:os.cursor,topmost:os.island.topmost,visible:os.island.visible,nativeHover:dom.nativeHover.slice(-3)}));process.exit(0);
