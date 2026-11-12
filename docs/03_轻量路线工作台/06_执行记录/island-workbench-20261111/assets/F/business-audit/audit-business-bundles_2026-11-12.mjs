// 日期：2026-11-12。只读打包图审计，输出均位于F证据目录。
import {createRequire} from 'node:module';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=String.raw`G:\rust\Codex-task-monitoring`;
const app=path.join(root,'app');
const out=path.dirname(fileURLToPath(import.meta.url));
const require=createRequire(path.join(app,'package.json'));
const {build}=require('esbuild');
const directories=new Set();const bundles=[];
for (const [name,entry,platform] of [['frontend','src/main.tsx','browser'],['server','server/index.mjs','node'],['mcp','mcp/light-stdio.mjs','node']]) {
 const result=await build({absWorkingDir:app,entryPoints:[entry],bundle:true,format:'esm',platform,write:false,metafile:true,outdir:path.join(out,'virtual-'+name),external:platform==='node'?['node:*']:[],logLevel:'silent'});
 const packages=new Set();
 for(const input of Object.keys(result.metafile.inputs)){
  const normalized=input.replaceAll('\\','/');const i=normalized.lastIndexOf('node_modules/');if(i<0)continue;
  const parts=normalized.slice(i+13).split('/');const name=parts[0].startsWith('@')?parts.slice(0,2).join('/'):parts[0];
  const d=path.resolve(app,normalized.slice(0,i),'node_modules',name);directories.add(d);packages.add(d);
 }
 bundles.push({name,entry,platform,inputs:Object.keys(result.metafile.inputs),packageDirectories:[...packages].sort(),externalImports:[...new Set(Object.values(result.metafile.outputs).flatMap(x=>x.imports.filter(i=>i.external).map(i=>i.path)))]});
}
const texts=[];const packages=[];
for(const directory of [...directories].sort()){
 const m=JSON.parse(await readFile(path.join(directory,'package.json'),'utf8'));
 const names=(await readdir(directory)).filter(n=>/^(licen[sc]e|copying|notice|copyright|unlicense)/i.test(n));
 const licenseFiles=[];
 for(const n of names){let text;try{text=await readFile(path.join(directory,n),'utf8')}catch{continue;}texts.push(`${m.name}@${m.version} — ${m.license}\n来源：${typeof m.repository==='object'?m.repository.url:m.repository??''}\n文件：${n}\n${text}`);licenseFiles.push({name:n,sha256:createHash('sha256').update(text).digest('hex')});}
 if(!licenseFiles.length)throw Error(`Missing license text ${m.name}`);
 packages.push({name:m.name,version:m.version,license:m.license,licenseFiles});
}
const nodeLicense=await readFile(path.join(app,'desktop/resources/NODE-LICENSE'),'utf8');
texts.push(`Node.js v25.5.0（本机已核对分发资源）\n来源：https://nodejs.org/dist/v25.5.0/\n文件：NODE-LICENSE\n${nodeLicense}`);
await writeFile(path.join(out,'BUSINESS-THIRD-PARTY-NOTICES_2026-11-12.txt'),`日期：2026-11-12\n状态：本地构建图核对完成；最终发行须与所用锁文件、Node版本和资源清单复核\n范围：本业务仓库前端、独立Node服务及MCP运行包；不包含旧Tauri桌面、原型或未分发图标\n\n${texts.join('\n\n----------------\n\n')}\n`,'utf8');
await writeFile(path.join(out,'business-bundle-packages_2026-11-12.json'),JSON.stringify({date:'2026-11-12',bundles,packages,nodeVersion:'25.5.0',nodeLicenseSha256:createHash('sha256').update(nodeLicense).digest('hex')},null,2)+'\n','utf8');
console.log(JSON.stringify({bundles:bundles.map(x=>({name:x.name,packages:x.packageDirectories.length,externalImports:x.externalImports})),packages:packages.length,noticeBytes:Buffer.byteLength(texts.join('\n\n'))}));
