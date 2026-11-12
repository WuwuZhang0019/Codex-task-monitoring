// 日期：2026-11-12。冻结F证据，分别核对工作区字节与暂存Git对象。
import {readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root='G:/rust/Codex-task-monitoring';
const directory='docs/03_轻量路线工作台/06_执行记录/island-workbench-20261111';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const artifacts=[];
async function visit(relative){for(const entry of await readdir(path.join(root,relative),{withFileTypes:true})){const file=`${relative}/${entry.name}`;if(entry.isDirectory())await visit(file);else{const raw=await readFile(path.join(root,file));const staged=execFileSync('git',['show',`:${file}`],{cwd:root,windowsHide:true,maxBuffer:16*1024*1024});const exact=hash(raw)===hash(staged);if(!exact)throw Error(`Frozen evidence byte mismatch: ${file}`);artifacts.push({path:file,bytes:raw.length,sha256:hash(raw),gitBlobSHA256:hash(staged),stagedBytesMatch:exact});}}}
await visit(`${directory}/assets/F`);
const skillBase='C:/Users/Zyf/.codex/plugins/cache/task-workbench-u01-local/task-workbench/0.1.6/skills/workbench-handoff';
const skill=[];for(const file of ['SKILL.md','references/execution-sync.md','references/handoff-template.md']){const p=path.join(skillBase,file);skill.push({path:p,sha256:hash(await readFile(p))});}
const output={date:'2026-11-12',planKey:'island-workbench-20261111',stage:'F',localStatus:'completed',acceptance:'passed',progress:{completed:6,total:6},handoffConclusion:'E',localExecutionKey:'island-workbench-20261111/local/F-20261112-01',completionKey:'island-workbench-20261111/local/F-20261112-01/complete-20261112',responsibleThread:'01a1cdcb-fc4c-7580-96c9-b2979497b072',serviceIdentity:null,sync:'deferredByAuthorization',serviceSynced:false,publicRelease:false,businessCommit:'1e4aa21678733930d36590a0a67fe6506f51f595',shellCommit:'94a2d959ee0e04d47813368b1584a74e24e0605f',protocolVersion:'island-workbench/1',skillSource:{package:'task-workbench/0.1.6',visibility:'explicitly invoked by user; source read and execution workflow applied',files:skill},checks:[{name:'E prerequisite original artifact hashes',result:'passed',count:34},{name:'business service/MCP + domain + Skill',result:'passed',count:155},{name:'desktop isolated lifecycle/recovery',result:'passed',count:9},{name:'packaged Node service smoke',result:'passed',count:6},{name:'shell Bun tests/assertions',result:'passed',tests:24,assertions:85},{name:'shell Rust lib',result:'passed',count:28},{name:'shell lint/build/clippy/clean NSIS',result:'passed'},{name:'browser delivery delta',result:'passed',count:11},{name:'tray branches/PNG static checks',result:'passed',count:6},{name:'minimum business source ZIP build',result:'passed'},{name:'independent final source/manifest review',result:'passed',details:'all five artifact hashes; three ZIP integrity; 149 business and 177 shell source files; required imports/resources complete'}],artifacts};
await writeFile(path.join(root,directory,'F_验收证据索引_2026-11-12.json'),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({artifacts:artifacts.length,allStagedBytesMatch:true,skillFiles:skill.length}));
