// 日期：2026-11-08。验证交付命令，使用独立目录和固定生产端口。
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import {mkdtemp,rm,mkdir,readFile,writeFile,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),repo=path.dirname(app),out=path.join(app,'test-results','m06');await mkdir(out,{recursive:true});
// Do not load an operator's local credentials during acceptance.
let hasEnv=false;try{await access(path.join(app,'.env'));hasEnv=true;}catch(e){if(e.code!=='ENOENT')throw e;}assert.equal(hasEnv,false,'存在 app/.env，不能在无隔离配置的情况下执行此启动测试');
const probe=net.createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(4318,'127.0.0.1',resolve);});await new Promise(r=>probe.close(r));
const dataDir=await mkdtemp(path.join(out,'startup-'));let child;let log='';
try{
 const env=Object.fromEntries(['PATH','SystemRoot','WINDIR','ComSpec','TMP','TEMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));env.WORKBENCH_DATA_DIR=dataDir;
 child=spawn(process.execPath,['app/server/index.mjs'],{cwd:repo,env,windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.on('data',v=>{log+=v;});child.stderr.on('data',v=>{log+=v;});
 await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('启动超时：'+log)),10000);child.stdout.on('data',()=>{if(log.includes('http://127.0.0.1:4318')){clearTimeout(timeout);resolve();}});child.once('exit',code=>{clearTimeout(timeout);reject(new Error('启动退出 '+code+': '+log));});});
 const health=await fetch('http://127.0.0.1:4318/api/health').then(r=>r.json());assert.equal(health.ok,true);assert.equal(health.ai.configured,false);
 assert.equal(await fetch('http://127.0.0.1:4318/').then(r=>r.text()),await readFile(path.join(app,'dist/index.html'),'utf8'));
 assert.deepEqual(await fetch('http://127.0.0.1:4318/api/projects').then(r=>r.json()),{projects:[]});assert.deepEqual(JSON.parse(await readFile(path.join(dataDir,'projects.json'),'utf8')),{version:1,projects:[]});
 await writeFile(path.join(out,'startup.json'),JSON.stringify({date:'2026-11-08',status:'passed',command:'node app/server/index.mjs',cwd:repo,url:'http://127.0.0.1:4318',health,log,checks:['固定端口启动','生产index逐字符一致','隔离目录生成','未配置AI可运行']},null,2),'utf8');console.log('PASS M06 实际启动命令、固定访问地址、生产构建一致、独立数据目录及无AI运行');
}finally{if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}assert.equal(path.dirname(dataDir),out);await rm(dataDir,{recursive:true,force:true});}
