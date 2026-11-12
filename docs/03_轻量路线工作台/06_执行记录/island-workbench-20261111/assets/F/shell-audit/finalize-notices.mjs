// 日期：2026-11-12。汇总实际分发依赖许可，保留补证来源。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root='G:/rust/windows-dynamic-island';
const out=path.dirname(fileURLToPath(import.meta.url));
const inv=JSON.parse(fs.readFileSync(path.join(out,'dependency-and-resource-inventory_2026-11-12.json'),'utf8'));
const sup=JSON.parse(fs.readFileSync(path.join(out,'license-supplements_2026-11-12.json'),'utf8'));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const read=p=>fs.readFileSync(p,'utf8');
const lock=createRequire(path.join(root,'package.json'))('json5').parse(read(path.join(root,'bun.lock')));
const runtime=new Set(Object.keys(lock.workspaces[''].dependencies));
for(let changed=true;changed;){changed=false;for(const key of [...runtime]){for(const d of Object.keys(lock.packages[key]?.[2]?.dependencies??{})){if(!runtime.has(d)){runtime.add(d);changed=true;}}}}
const mpl=inv.rust.find(p=>p.name==='cssparser');
const mplFrom=path.join(path.dirname(mpl.manifest),'LICENSE');
const mplName='license-supplements/selectors-0.38.0-MPL-2.0.txt';
fs.copyFileSync(mplFrom,path.join(out,mplName));
sup.items.find(p=>p.name==='selectors').files.push({localFile:mplName,sourcePath:mplFrom,sha256:sha(fs.readFileSync(mplFrom)),basis:'selectors/lib.rs explicit MPL-2.0 header; standard MPL-2.0 text copied verbatim from installed cssparser-0.37.0/LICENSE, not presented as selectors-specific copyright.'});
const txt=['第三方许可与版权声明','日期：2026-11-12',`审计固定Fork ${inv.head}，上游 ${inv.upstream}。`,
'范围：全部Windows目标Cargo解析包（含构建依赖）及已安装Bun包；未安装的其他平台可选工具不随Windows产品分发，锁定身份仍见JSON。原文保持原语言。',
'本项目GPL-3.0-or-later全文另附LICENSE。以下第三方代码保留各自许可和版权。',
'对于没有随crate打包的许可文件，采用该crate .cargo_vcs_info.json 精确Git提交的官方仓库原文；selectors按明确源码许可头补标准MPL-2.0正文。'];
const gaps=[];
const wrappers={'@biomejs/cli-win32-x64':'@biomejs/biome','@rolldown/binding-win32-x64-msvc':'rolldown','@tailwindcss/oxide-wasm32-wasi':'@tailwindcss/oxide','@tauri-apps/cli-win32-x64-msvc':'@tauri-apps/cli'};
for(const p of inv.npm){
 txt.push(`\n===== npm ${p.name}@${p.version} =====\n许可声明：${JSON.stringify(p.metadata?.license??null)}；${runtime.has(p.key)?'前端运行依赖':'开发/构建或平台可选依赖'}。`);
 if(!p.metadata?.matched){txt.push('当前Windows安装树没有此锁定包；不随产品安装包分发。');continue;}
 let files=p.metadata.licenseFiles.map(f=>({file:path.join(root,'node_modules',p.key,f.file),basis:`installed ${p.name}@${p.version}`}));
 if(!files.length&&wrappers[p.key]){
  const w=inv.npm.find(x=>x.key===wrappers[p.key]);
  if(w?.metadata?.matched&&w.version===p.version) files=w.metadata.licenseFiles.map(f=>({file:path.join(root,'node_modules',w.key,f.file),basis:`same-version companion package ${w.name}@${w.version}; repository and SPDX declarations match; build binary not redistributed`}));
 }
 if(!files.length){gaps.push({kind:'npm',name:p.name,version:p.version,runtime:runtime.has(p.key)});txt.push('本地该开发包没有许可正文；只保留上面许可声明与JSON来源，不将其标为正文齐全。该开发工具本体不随产品分发。');}
 for(const f of files) txt.push(`来源：${f.basis}\n${read(f.file)}`);
}
for(const p of inv.rust){
 txt.push(`\n===== Cargo ${p.name}@${p.version} =====\n许可声明：${p.license}；仓库：${p.repository??'本项目'}。`);
 if(!p.source){txt.push(read(path.join(out,'GPL-3.0.txt')));continue;}
 const local=p.licenseFiles.map(f=>({file:path.join(path.dirname(p.manifest),f.file),basis:`installed crate/${f.file}`}));
 const remote=(sup.items.find(x=>x.name===p.name&&x.version===p.version)?.files??[]).filter(f=>f.localFile).map(f=>({file:path.join(out,f.localFile),basis:f.url??f.basis}));
 const all=[...local,...remote];
 if(!all.length)gaps.push({kind:'cargo',name:p.name,version:p.version});
 for(const f of all)txt.push(`来源：${f.basis}\n${read(f.file)}`);
}
fs.writeFileSync(path.join(out,'THIRD-PARTY-NOTICES.txt'),txt.join('\n')+'\n');
fs.writeFileSync(path.join(out,'notice-coverage_2026-11-12.json'),JSON.stringify({date:'2026-11-12',runtimePackages:[...runtime],runtimeCount:runtime.size,installedNpmCount:inv.summary.npmMatched,cargoPackages:inv.rust.length,supplementSources:sup.items,missingLicenseText:gaps},null,2)+'\n');
console.log(JSON.stringify({runtimeCount:runtime.size,gaps},null,2));
