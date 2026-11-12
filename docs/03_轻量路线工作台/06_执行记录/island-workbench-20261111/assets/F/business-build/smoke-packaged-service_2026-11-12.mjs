// 日期：2026-11-12。隔离发行资源冷起，凭据只在内存使用，不落入证据。
import path from 'node:path';
import fs from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const resource=String.raw`C:\Users\Zyf\.codex\worktrees\island-f-business-build\Codex-task-monitoring\app\desktop\resources`;
const root=String.raw`G:\rust\Codex-task-monitoring`;
const data=path.join(root,'app/test-results/island-F/service-cli-smoke-1e4aa2-20261112');
const out=path.dirname(fileURLToPath(import.meta.url));
const {startService,stopService}=await import(pathToFileURL(path.join(resource,'app/desktop/service.mjs')));
const {connectOwner}=await import(pathToFileURL(path.join(resource,'app/desktop/client.mjs')));
const run=promisify(execFile);
const cli=async action=>{const result=await run(process.execPath,[path.join(resource,'app/desktop/service.mjs'),action,'--data-dir',data],{windowsHide:true,timeout:40000});return JSON.parse(result.stdout);};
const summary={date:'2026-11-12',sourceCommit:'1e4aa21678733930d36590a0a67fe6506f51f595',nodeVersion:process.version,dataScope:'isolated new F smoke directory',commands:['bundled node.exe desktop/service.mjs start','bundled service client status/health','authenticated GET /api/light-panel','bundled service stop'],initialEmpty:false,checks:[]};
let started=false;
try {
 try {await fs.access(data);throw Error('SMOKE_ROOT_ALREADY_EXISTS')}catch(e){if(e.code!=='ENOENT')throw e;}
 await fs.mkdir(data,{recursive:true});summary.initialEmpty=true;
 const record=await cli('start');started=true;summary.checks.push({check:'cold start',passed:record.lifetime==='standalone'&&!record.attached,nodeVersion:record.nodeVersion});
 const cliStatus=await cli('status');summary.checks.push({check:'CLI status',passed:cliStatus.pid===record.pid});
 const {record:status,token}=await connectOwner(data);summary.checks.push({check:'status health',passed:status.pid===record.pid});
 const result=await new Promise((resolve,reject)=>{const req=http.get(`${record.endpoint}/api/light-panel`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(5000)},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>{try {const parsed=JSON.parse(body);resolve({status:res.statusCode,topLevelKeys:Object.keys(parsed),projects:Array.isArray(parsed.projects)?parsed.projects.length:null});}catch(e){reject(e)}})});req.once('error',reject)});
 summary.checks.push({check:'packaged snapshot read',passed:result.status===200,...result});
 const stopped=await cli('stop');started=false;summary.checks.push({check:'stop',passed:stopped.stopped===true});
 const forbidden=['owner.json','runtime-private/owner-session.json','runtime-private/panel-session.json','runtime-private/control.json'];const remaining=[];
 for(const f of forbidden){try{await fs.access(path.join(data,f));remaining.push(f)}catch(e){if(e.code!=='ENOENT')throw e;}}
 summary.checks.push({check:'discovery and credential cleanup',passed:remaining.length===0,remaining});
 summary.result=summary.checks.every(x=>x.passed)?'passed':'failed';
} catch(e){summary.result='failed';summary.error=e.message;}
finally {if(started){try{await stopService(data)}catch(e){summary.cleanupError=e.message;}}await fs.writeFile(path.join(out,'packaged-service-smoke_2026-11-12.json'),JSON.stringify(summary,null,2)+'\n','utf8');}
console.log(JSON.stringify(summary));if(summary.result!=='passed')process.exitCode=1;
