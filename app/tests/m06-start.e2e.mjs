// 日期：2026-11-08。验证交付命令，使用独立目录和固定生产端口。
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
import {mkdtemp,rm,mkdir,readFile,writeFile,cp} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),repo=path.dirname(app),out=path.join(app,'test-results','m06');await mkdir(out,{recursive:true});
// Run the delivered server/dist/template in a fresh checkout-shaped directory.
// No operator .env is read, renamed or removed.
const probe=net.createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(4318,'127.0.0.1',resolve);});await new Promise(r=>probe.close(r));
const dataDir=await mkdtemp(path.join(out,'startup-')),isolated=path.join(dataDir,'release');let child;let log='';
try{
 await mkdir(path.join(isolated,'app'),{recursive:true});await mkdir(path.join(isolated,'docs/99_归档/2026-11-10_旧路线/01_任务监测工作台_v1.0/01_执行方案'),{recursive:true});
 for(const name of ['server','dist'])await cp(path.join(app,name),path.join(isolated,'app',name),{recursive:true});
 await cp(path.join(repo,'docs/99_归档/2026-11-10_旧路线/01_任务监测工作台_v1.0/01_执行方案/02_任务收敛与交接指令_原文_2026-11-08.md'),path.join(isolated,'docs/99_归档/2026-11-10_旧路线/01_任务监测工作台_v1.0/01_执行方案/02_任务收敛与交接指令_原文_2026-11-08.md'));
 const env=Object.fromEntries(['PATH','SystemRoot','WINDIR','ComSpec','TMP','TEMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));env.WORKBENCH_DATA_DIR=dataDir;
 child=spawn(process.execPath,['app/server/index.mjs'],{cwd:isolated,env,windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.on('data',v=>{log+=v;});child.stderr.on('data',v=>{log+=v;});
 await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('启动超时：'+log)),10000);child.stdout.on('data',()=>{if(log.includes('http://127.0.0.1:4318')){clearTimeout(timeout);resolve();}});child.once('exit',code=>{clearTimeout(timeout);reject(new Error('启动退出 '+code+': '+log));});});
 const health=await fetch('http://127.0.0.1:4318/api/health').then(r=>r.json());assert.equal(health.ok,true);assert.equal(health.ai.configured,false);
 assert.equal(await fetch('http://127.0.0.1:4318/').then(r=>r.text()),await readFile(path.join(app,'dist/index.html'),'utf8'));
 assert.deepEqual(await fetch('http://127.0.0.1:4318/api/projects').then(r=>r.json()),{projects:[]});assert.deepEqual(JSON.parse(await readFile(path.join(dataDir,'aggregate.json'),'utf8')).projects,{version:1,projects:[]});
 await writeFile(path.join(out,'startup.json'),JSON.stringify({date:'2026-11-08',status:'passed',command:'node app/server/index.mjs',cwd:isolated,sourceRepository:repo,url:'http://127.0.0.1:4318',health,log,checks:['固定端口启动','生产index逐字符一致','隔离目录生成','未配置AI可运行']},null,2),'utf8');console.log('PASS M06 实际启动命令、固定访问地址、生产构建一致、独立数据目录及无AI运行');
}finally{if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}assert.equal(path.dirname(dataDir),out);await rm(dataDir,{recursive:true,force:true});}
