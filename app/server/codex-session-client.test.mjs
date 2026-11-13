// 日期：2026-11-13。新会话隔离桌面启动身份，保留用户正常配置环境。
import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionEnvironment} from './codex-session-client.mjs';
test('standalone stages never inherit a parent chat identity or registered desktop launcher',()=>{
 const input={PATH:'tools',APPDATA:'data',CODEX_HOME:'config',CODEX_WINDOWS_REGISTERED_CORE:'1',CODEX_THREAD_ID:'parent',CODEX_SESSION_ID:'parent',CODEX_APP_TOOLS_PIPE_PATH:'parent-pipe'};
 assert.deepEqual(sessionEnvironment(input),{PATH:'tools',APPDATA:'data',CODEX_HOME:'config'});
 assert.equal(input.CODEX_THREAD_ID,'parent');
});
