// 日期：2026-11-12。交付文件独立复核；不修改安装或运行数据。
import {readFile,writeFile,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const base='G:/rust/Codex-task-monitoring';
const records=path.join(base,'docs/03_轻量路线工作台/06_执行记录/island-workbench-20261111');
const delivery=path.join(base,'app/test-results/island-F/delivery');
const sources=JSON.parse(await readFile(path.join(delivery,'source-manifest.json'),'utf8'));
const business=JSON.parse((await readFile(path.join(records,'assets/F/business-build/business-delivery_2026-11-12.json'),'utf8')).replace(/^\uFEFF/,''));
const shell=JSON.parse((await readFile(path.join(records,'assets/F/shell-build/shell-clean-build_2026-11-12.json'),'utf8')).replace(/^\uFEFF/,''));
const items=[...sources.sources.map(s=>({kind:s.name,path:s.file,sha256:s.sha256,bytes:s.bytes,sourceCommit:s.commit})),
 {kind:'business-service',path:business.package,sha256:business.packageSha256,bytes:business.packageBytes,sourceCommit:business.sourceCommit},
 ...shell.artifacts.slice(0,2).map((s,i)=>({...s,kind:i?'shell-nsis-installer':'shell-native-executable',sourceCommit:shell.sourceCommit}))];
for(const item of items){const bytes=await readFile(item.path);if(bytes.length!==item.bytes||createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw Error(`Delivery mismatch: ${item.path}`);item.verified=true;}
const manifest={date:'2026-11-12',planKey:'island-workbench-20261111',stage:'F',localStatus:'completed',acceptance:'passed',localProgress:'6/6',handoffConclusion:'E',businessCommit:business.sourceCommit,shellCommit:shell.sourceCommit,protocolVersion:'island-workbench/1',snapshotSchema:'light-1.0',serviceIdentity:null,serviceSynced:false,sync:'deferredByAuthorization',publicRelease:false,installed:false,buildProfile:'debug / unsigned NSIS; independent Node service',artifacts:items,sourceEntries:sources.sources.map(s=>({kind:s.name,count:s.entries.length})),limitations:['Multi-monitor not tested','125% interactions; 150% system/native geometry only','Same-source install upgrade/downgrade mechanism only','Old UI deleted; no MSI/MSIX/store release','New F NSIS was built, not installed or physically user-accepted','Historical E installed path now D4831E26..., source of drift unconfirmed; historical E evidence remains pinned to BA112...','No cross-machine bit-for-bit reproducibility claim'],evidence:{business:'assets/F/business-build/business-delivery_2026-11-12.json',shell:'assets/F/shell-build/shell-clean-build_2026-11-12.json',sourceVerification:'assets/F/source-verify/source-build-verification_2026-11-12.json'}};
await writeFile(path.join(records,'F_交付清单_2026-11-12.json'),JSON.stringify(manifest,null,2)+'\n');
await writeFile(path.join(delivery,'delivery-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
await copyFile(path.join(records,'F_发布与构建说明_2026-11-12.md'),path.join(delivery,'BUILD-AND-RELEASE_2026-11-12.md'));
console.log(JSON.stringify(items.map(i=>({kind:i.kind,sha256:i.sha256,verified:i.verified}))));
