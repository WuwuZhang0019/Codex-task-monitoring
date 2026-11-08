import test from 'node:test';
import assert from 'node:assert/strict';
import {createAI} from './ai.mjs';

const body={text:'隔离摘要',step:{id:'S',title:'隔离',purpose:'仅测试',acceptance:['摘要有效']}};
function delayed(ms){return (_url,options)=>new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>resolve(new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({summary:'完成隔离摘要',nextAction:'',blocker:''})}}]}))),ms);
 options.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('aborted'));},{once:true});
});}
test('配置较长预算可接收慢响应，超限仍返回明确504且不泄露密钥',async()=>{
 const env={OPENAI_API_KEY:'isolated-secret',OPENAI_TIMEOUT_MS:'200'};
 const result=await createAI({env,fetchImpl:delayed(40)}).summarize(body);assert.equal(result.summary,'完成隔离摘要');
 await assert.rejects(createAI({env:{...env,OPENAI_TIMEOUT_MS:'10'},fetchImpl:delayed(80)}).summarize(body),e=>e.status===504&&e.message.includes('OPENAI_TIMEOUT_MS')&&!e.message.includes(env.OPENAI_API_KEY));
});
test('无效预算拒绝，显式测试覆盖值仍适用，默认预算允许普通响应',async()=>{
 for(const value of ['0','-1','NaN','300001','1.5'])assert.throws(()=>createAI({env:{OPENAI_TIMEOUT_MS:value}}),/OPENAI_TIMEOUT_MS/);
 const env={OPENAI_API_KEY:'isolated',OPENAI_TIMEOUT_MS:'1'};
 assert.equal((await createAI({env,timeoutMs:200,fetchImpl:delayed(30)}).summarize(body)).summary,'完成隔离摘要');
 assert.equal((await createAI({env:{OPENAI_API_KEY:'isolated'},fetchImpl:delayed(30)}).summarize(body)).summary,'完成隔离摘要');
});
