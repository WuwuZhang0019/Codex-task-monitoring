// 日期：2026-11-12。E 收尾证据字节核验；不启动应用，不连接服务，不修改业务数据。
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';

const root=process.cwd();
const base='docs/03_轻量路线工作台/06_执行记录/island-workbench-20261111';
const own=`${base}/E_续验证据索引_2026-11-12.json`;
const sha=b=>createHash('sha256').update(b).digest('hex');
const bytes=rel=>readFile(path.join(root,rel));
const json=async rel=>JSON.parse((await bytes(rel)).toString('utf8').replace(/^\uFEFF/,''));
const artifact=async rel=>{const b=await bytes(rel);return {path:rel,bytes:b.length,sha256:sha(b)};};
const reused=[];
for(const stage of ['D','E']){
 const indexPath=`${base}/${stage}_证据索引_2026-11-12.json`;
 const index=await json(indexPath);
 for(const a of index.artifacts){const b=await bytes(a.path);assert.equal(b.length,a.bytes,a.path);assert.equal(sha(b),a.sha256.toLowerCase(),a.path);}
 const indexBlob=execFileSync('git',['show',`:${indexPath}`],{cwd:root,windowsHide:true});
 assert.deepEqual(JSON.parse(indexBlob.toString('utf8')),index,'historical index semantic equality');
 reused.push({...await artifact(indexPath),gitBlobSHA256:sha(indexBlob),validatedArtifacts:index.artifacts.length,bytePolicy:'worktree raw SHA and Git blob SHA recorded separately; historical autocrlf is preserved; JSON semantics must match'});
}
const evidenceDir=`${base}/assets/E/continuation`;
if(process.argv.includes('--write-index')){
 const files=(await readdir(path.join(root,evidenceDir))).sort().map(n=>`${evidenceDir}/${n}`);
 files.push(`${base}/E_续验记录_2026-11-12.md`,`${base}/E_完成回执_2026-11-12.md`);
 const index={date:'2026-11-12',planKey:'island-workbench-20261111',stage:'E',localStatus:'completed',acceptance:'passed',handoffConclusion:'C',progress:{completed:5,total:6},sync:'deferredByAuthorization',serviceIdentity:null,serviceSynced:false,localExecutionKey:'island-workbench-20261111/local/E-20261112-01',completionKey:'island-workbench-20261111/local/E-20261112-01/complete-20261112',businessStartCommit:'7bd662f20f6b2902382ca1f1e63889527117c702',acceptedForkCommit:'77574bfe7f0b561b092165ed824da0d56cc3e66f',parallelForkCommit:'405f7cef3d9a2838c3cdaf1dd96ebaaee9b0153b',installedExeSHA256:'ba112bb56c228da9b7922eba3e30dff58c4e16d42eb61bb5b6347c4131c5736e',protocolVersion:'island-workbench/1',userFeedback:'托盘三项正常，整体观感通过',nextStage:{stage:'F',status:'pending',dispatched:false,requiresOwnAuthorization:true},limitations:['Multi-monitor not tested: only one active display','125% interactions plus actual 150% system/native geometry; not all interaction/DPI combinations','Old UI was deleted; same-source install version upgrade/downgrade only','CDP controlled events and physical mouse evidence remain distinct','Parallel sidebar/tray-icon source revisions are outside accepted BA112 binary'],reusedEvidenceIndexes:reused,artifacts:await Promise.all(files.map(artifact))};
 await writeFile(path.join(root,own),JSON.stringify(index,null,2)+'\n');
}
const index=await json(own);
for(const a of index.artifacts){const b=await bytes(a.path);assert.equal(b.length,a.bytes,a.path);assert.equal(sha(b),a.sha256,a.path);}
assert.equal((await json(`${evidenceDir}/native-webview-acceptance_2026-11-12.json`)).checks.filter(x=>x.result==='passed').length,7);
assert.equal((await json(`${evidenceDir}/dynamic-native-recheck_2026-11-12.json`)).passed,true);
const hit=await json(`${evidenceDir}/physical-hit-test_2026-11-12.json`);assert.equal(hit.passed,true);assert.equal(hit.cycles.length,3);
for(const label of ['on','restored']){
 const point=await json(`${evidenceDir}/physical-click-${label}_2026-11-12.json`);
 assert.equal(point.pointInHit,false);assert.equal(point.os.island.visible,true);assert.equal(point.os.island.topmost,true);assert.equal(point.os.island.transparent,true);assert.equal(point.os.underCursor.handle,point.os.settings.owner.handle);
 assert.ok(point.os.cursor.x<point.os.island.rect.right&&point.os.cursor.y<point.os.island.rect.bottom);
}
assert.match((await json(`${evidenceDir}/physical-click-run-on_2026-11-12.json`)).runValue,/installed-shell\\dynamic-island\.exe/);
assert.equal((await json(`${evidenceDir}/physical-click-run-restored_2026-11-12.json`)).absent,true);
assert.equal((await json(`${evidenceDir}/configuration-restore_2026-11-12.json`)).passed,true);
const final=await json(`${evidenceDir}/final-runtime_2026-11-12.json`);assert.equal(final.passed,true);assert.equal(final.debugPortListenerCount,0);assert.equal(final.processCount,1);
assert.equal((await json(`${evidenceDir}/user-acceptance_2026-11-12.json`)).answer,'托盘三项正常，整体观感通过');
if(process.argv.includes('--staged')){
 for(const a of [...index.artifacts,await artifact(own)]){
  const b=execFileSync('git',['show',`:${a.path}`],{cwd:root,maxBuffer:20*1024*1024,windowsHide:true});assert.equal(sha(b),a.sha256,`staged:${a.path}`);
 }
 for(const a of index.reusedEvidenceIndexes){const b=execFileSync('git',['show',`:${a.path}`],{cwd:root,windowsHide:true});assert.equal(sha(b),a.gitBlobSHA256,`historical:${a.path}`);assert.deepEqual(JSON.parse(b.toString('utf8')),await json(a.path));}
}
console.log(JSON.stringify({date:'2026-11-12',reused:reused.map(x=>({path:x.path,validated:x.validatedArtifacts})),newArtifacts:index.artifacts.length,staged:process.argv.includes('--staged'),result:'passed'}));
