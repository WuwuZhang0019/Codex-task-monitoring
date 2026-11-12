// 日期：2026-11-12。仅从本地crate元数据指定仓库的精确提交补齐许可原文。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const out=path.dirname(fileURLToPath(import.meta.url));
const inv=JSON.parse(fs.readFileSync(path.join(out,'dependency-and-resource-inventory_2026-11-12.json'),'utf8'));
const items=inv.rust.filter(p=>!p.licenseFiles.length&&p.source);
const results=[];
for (const p of items) {
 const vcs=JSON.parse(fs.readFileSync(path.join(path.dirname(p.manifest),'.cargo_vcs_info.json'),'utf8'));
 const repo=p.repository.replace('https://github.com/','').replace(/\.git$/,'');
 const treeUrl=`https://api.github.com/repos/${repo}/git/trees/${vcs.git.sha1}?recursive=1`;
 let tree; let treeError=null;
 try { const res=await fetch(treeUrl,{headers:{'User-Agent':'Codex-license-audit'},signal:AbortSignal.timeout(20000)}); if(!res.ok)throw Error(`${res.status}`); tree=await res.json(); }
 catch(e){ treeError=String(e); }
 const relevant=tree ? tree.tree.filter(f=>f.type==='blob'&&/^(LICENSE|LICENCE|COPYING|NOTICE|COPYRIGHT)([-_.].*)?$/i.test(path.posix.basename(f.path)) && (path.posix.dirname(f.path)==='.' || path.posix.dirname(f.path)===vcs.path_in_vcs)) : ['LICENSE','LICENSE-MIT','LICENSE-APACHE','LICENSE_MIT','LICENSE_APACHE','COPYING',`${vcs.path_in_vcs}/LICENSE`].map(path=>({path}));
 const files=[];
 await Promise.all(relevant.map(async f => {
  const url=`https://raw.githubusercontent.com/${repo}/${vcs.git.sha1}/${f.path}`;
  try { const res=await fetch(url,{signal:AbortSignal.timeout(20000)}); if(!res.ok)throw Error(`${res.status}`); const content=await res.text(); const name=`${p.name}-${p.version}-${f.path.replaceAll('/','_')}`; fs.mkdirSync(path.join(out,'license-supplements'),{recursive:true}); fs.writeFileSync(path.join(out,'license-supplements',name),content); files.push({url,sourcePath:f.path,localFile:`license-supplements/${name}`,sha256:crypto.createHash('sha256').update(content).digest('hex')}); }
  catch(e){ files.push({url,error:String(e)}); }
 }));
 results.push({name:p.name,version:p.version,repository:p.repository,revision:vcs.git.sha1,pathInVcs:vcs.path_in_vcs,treeUrl,treeError,files});
}
fs.writeFileSync(path.join(out,'license-supplements_2026-11-12.json'),JSON.stringify({date:'2026-11-12',items:results},null,2)+'\n');
console.log(results.map(r=>({name:r.name,files:r.files?.length,error:r.error})));
