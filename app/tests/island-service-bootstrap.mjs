// 日期：2026-11-13。实际运行版启动验收；仅启动界面，不手动启动后台。
import {spawn} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {connectOwner} from '../desktop/client.mjs';
import {stopService} from '../desktop/service.mjs';
const [island,dataDir]=process.argv.slice(2);if(!island||!dataDir)throw Error('Provide absolute island executable and data directory');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
try{await stopService(dataDir);}catch(error){if(!['ECONNREFUSED','ENOENT'].includes(error.code)&&error.message!=='STOPPED')throw error;}
let child;
const results=[];
async function launch(label){
 child=spawn(island,[],{detached:true,windowsHide:true,stdio:'ignore'});child.unref();let connected;
 for(let i=0;i<40;i++){try{connected=await connectOwner(dataDir);break;}catch{await delay(500);}}
 if(!connected)throw Error('APP_BOOTSTRAP_FAILED: '+await readFile(dataDir+'/service-startup.json','utf8').catch(()=>label));
 const {record,token}=connected;const response=await fetch(record.endpoint+'/api/light-panel',{headers:{Authorization:'Bearer '+token}});const panel=await response.json();
 if(response.status!==200||!panel.snapshot?.plans.length)throw Error('PANEL_NOT_RESTORED');
 results.push({label,record,plans:panel.snapshot.plans.length});console.log(JSON.stringify(results.at(-1)));return record;
}
const initial=await launch('stopped service');child.kill();await delay(1000);
process.kill(initial.pid);await delay(1000);
const recovered=await launch('stale discovery after service crash');if(recovered.ownerGeneration===initial.ownerGeneration)throw Error('STALE_OWNER_REUSED');
await writeFile(new URL('../test-results/continuous-button/bootstrap-acceptance.json',import.meta.url),JSON.stringify({date:'2026-11-13',passed:true,actualOsReboot:false,results},null,2));
console.log('2 native service bootstrap checks passed');
