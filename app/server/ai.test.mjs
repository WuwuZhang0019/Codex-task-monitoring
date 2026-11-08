import test from 'node:test';
import assert from 'node:assert/strict';
import {createAI} from './ai.mjs';

for(const mode of ['api-key','bearer'])test(`模型认证 ${mode} 只发送所选认证头`,async()=>{
 const ai=createAI({env:{OPENAI_API_KEY:'isolated-secret',OPENAI_MODEL:'isolated-model',OPENAI_BASE_URL:'https://example.invalid/v1',OPENAI_AUTH_HEADER:mode},fetchImpl:async(url,options)=>{
  assert.equal(url,'https://example.invalid/v1/chat/completions');
  assert.equal(options.headers['api-key'],mode==='api-key'?'isolated-secret':undefined);
  assert.equal(options.headers.Authorization,mode==='bearer'?'Bearer isolated-secret':undefined);
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({summary:'摘要',nextAction:'核对',blocker:''})}}]});
 }});
 assert.equal((await ai.summarize({text:'隔离输入',step:{id:'S',title:'核对',purpose:'核对',acceptance:['核对完成']}})).summary,'摘要');
});
