// 日期：2026-11-12。只读核对锁定的本地依赖与来源；输出仅限指定证据目录。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = 'G:/rust/windows-dynamic-island';
const out = path.dirname(fileURLToPath(import.meta.url));
const req = createRequire(path.join(root, 'package.json'));
const parse = req('json5').parse;
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const read = p => fs.readFileSync(p, 'utf8');
const git = (...a) => execFileSync('git', ['-C', root, ...a], {encoding:'utf8'}).trim();
const licenseNames = dir => fs.readdirSync(dir).filter(n => /^(licen[cs]e|copying|notice|copyright)(\b|[._-])/i.test(n) && fs.statSync(path.join(dir,n)).isFile());
const lock = parse(read(path.join(root,'bun.lock')));
const npm = Object.entries(lock.packages).map(([key,item]) => {
 const spec=item[0]; const at=spec.lastIndexOf('@'); const name=spec.slice(0,at); const version=spec.slice(at+1);
 let dir=path.join(root,'node_modules',key); let evidence=null;
 try { const pkg=JSON.parse(read(path.join(dir,'package.json'))); evidence={actualName:pkg.name,actualVersion:pkg.version,license:pkg.license??pkg.licenses??null,licenseFiles:licenseNames(dir).map(n=>({file:n,sha256:sha(fs.readFileSync(path.join(dir,n)))})),repository:pkg.repository??null,matched:pkg.name===name&&pkg.version===version}; } catch {}
 return {key,name,version,integrity:item.at(-1),metadata:evidence};
});
const cargo=JSON.parse(execFileSync('cargo',['metadata','--offline','--locked','--filter-platform','x86_64-pc-windows-msvc','--format-version','1','--manifest-path',path.join(root,'src-tauri/Cargo.toml')],{encoding:'utf8',maxBuffer:30*1024*1024}));
const rust=cargo.packages.map(p=>({name:p.name,version:p.version,source:p.source,license:p.license,licenseFile:p.license_file,repository:p.repository,manifest:p.manifest_path,licenseFiles:licenseNames(path.dirname(p.manifest_path)).map(n=>({file:n,sha256:sha(fs.readFileSync(path.join(path.dirname(p.manifest_path),n)))}))}));
const tracked=git('ls-files').split('\n');
const assets=tracked.filter(p=>/\.(woff2?|ttf|otf|png|svg|ico|icns|jpe?g|webp|gif|mp3|wav|mp4|webm)$/i.test(p)).map(p=>({path:p,sha256:sha(fs.readFileSync(path.join(root,p))),lastChange:git('log','-1','--format=%H %cs','--',p)}));
const result={date:'2026-11-12',root,head:git('rev-parse','HEAD'),upstream:git('rev-parse','upstream/main'),accepted:'77574bfe7f0b561b092165ed824da0d56cc3e66f',lockHashes:{bun:sha(read(path.join(root,'bun.lock'))),cargo:sha(read(path.join(root,'src-tauri/Cargo.lock')))},npm,rust,assets,summary:{npmLocked:npm.length,npmMatched:npm.filter(p=>p.metadata?.matched).length,npmMissing:npm.filter(p=>!p.metadata?.matched).map(p=>p.key),npmNoLicense:npm.filter(p=>p.metadata?.matched&&!p.metadata.license).map(p=>p.key),rustLocked:rust.length,rustMissingLicense:rust.filter(p=>!p.license&&!p.licenseFile).map(p=>p.name),assetCount:assets.length}};
fs.writeFileSync(path.join(out,'dependency-and-resource-inventory_2026-11-12.json'),JSON.stringify(result,null,2)+'\n');
const lines=['日期：2026-11-12','依赖许可原文副本；来源路径和哈希见JSON。'];
for (const p of npm.filter(p=>p.metadata?.matched)) for(const f of p.metadata.licenseFiles) lines.push(`\n--- npm ${p.name}@${p.version} / ${f.file} ---\n${read(path.join(root,'node_modules',p.key,f.file))}`);
for (const p of rust) for(const f of p.licenseFiles) lines.push(`\n--- cargo ${p.name}@${p.version} / ${f.file} ---\n${read(path.join(path.dirname(p.manifest),f.file))}`);
fs.writeFileSync(path.join(out,'dependency-license-texts_2026-11-12.txt'),lines.join('\n'));
fs.copyFileSync(path.join(root,'LICENSE'),path.join(out,'GPL-3.0.txt'));
process.stdout.write(JSON.stringify(result.summary,null,2));
