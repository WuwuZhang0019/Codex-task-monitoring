// 日期：2026-11-13。公开项目协议的虚拟进程验证，不创建真实项目。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { HostProjectClient, projectEnvironment, hostProjectCli } from '../../plugins/task-workbench/skills/workbench-handoff/scripts/host-project-client.mjs';

const params = { idempotencyKey: 'stable-project-create-key', name: '测试项目', roots: [{ path: 'G:\\fixture\\ab' }] };
function fixture(handler = () => ({}), timeoutMs = 100) {
  const requests = []; let options, executable, args, launches = 0;
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, _, done) {
    const message = JSON.parse(chunk.toString()); requests.push(message);
    if (message.id !== undefined) queueMicrotask(() => {
      const value = message.method === 'initialize' ? {} : handler(message, child);
      if (value !== undefined) child.stdout.write(JSON.stringify({ id: message.id, ...value }) + '\n');
    });
    done();
  } });
  child.kill = () => { child.emit('exit', 0); child.stdout.end(); };
  const client = new HostProjectClient({ executable: 'exact-codex.exe', timeoutMs,
    environment: { PATH: 'tools', CODEX_HOME: 'normal-config', CODEX_THREAD_ID: 'parent', CODEX_APP_TOOLS_PIPE_PATH: 'parent-pipe', CODEX_APP_TOOLS_CALLER_HOST_ID: 'parent-host' },
    spawnImpl: (file, arguments_, options_) => { launches++; executable = file; args = arguments_; options = options_; return child; } });
  return { client, child, requests, get options() { return options; }, get launches() { return launches; }, get executable() { return executable; }, get args() { return args; } };
}

test('初始化真实 experimentalApi 协商，精确传递创建幂等键及 roots，shell 关闭', async () => {
  const f = fixture(message => ({ result: { project: { id: 'native-project', ...message.params } } }));
  try {
    const value = await f.client.create(params);
    assert.equal(value.project.id, 'native-project'); assert.equal(f.executable, 'exact-codex.exe');
    assert.deepEqual(f.args, ['app-server', '--stdio']); assert.equal(f.options.windowsHide, true); assert.equal(f.options.shell, false);
    assert.deepEqual(f.options.env, { PATH: 'tools', CODEX_HOME: 'normal-config' });
    assert.equal(f.requests[0].params.capabilities.experimentalApi, true);
    assert.equal(f.requests[1].method, 'initialized'); assert.deepEqual(f.requests[2].params, params);
    assert.equal(f.requests.some(r => r.method.startsWith('thread/') || r.method.startsWith('turn/')), false);
  } finally { f.client.close(); }
});

test('列表与回读返回完整公开响应，单连接复用且不发送模型请求', async () => {
  const f = fixture(message => ({ result: message.method === 'project/list' ? { data: [{ id: 'p', roots: params.roots }], nextCursor: 'next' } : { project: { id: message.params.projectId, roots: params.roots } } }));
  try {
    assert.equal((await f.client.list({ limit: 1 })).nextCursor, 'next');
    assert.equal((await f.client.read({ projectId: 'p' })).project.id, 'p');
    assert.equal(f.launches, 1); assert.deepEqual(f.requests.slice(2).map(x => x.method), ['project/list', 'project/read']);
  } finally { f.client.close(); }
});

test('缺幂等键、空/相对/重复 roots 和多余参数在启动执行器前拒绝', async () => {
  for (const value of [{ ...params, idempotencyKey: '' }, { ...params, name: '' }, { ...params, roots: [] },
    { ...params, roots: [{ path: 'relative' }] }, { ...params, roots: [{ path: 'G:\\fixture\\ab' }, { path: 'g:/fixture/AB/' }] },
    { ...params, metadata: { token: 1 } }, { ...params, threadId: 'forbidden' }]) {
    const f = fixture(); await assert.rejects(f.client.create(value)); assert.equal(f.launches, 0);
  }
  const f = fixture(); await assert.rejects(f.client.read({ projectId: '' }));
  await assert.rejects(f.client.list({ sortDirection: 'desc' })); await assert.rejects(f.client.list({ limit: -1 })); assert.equal(f.launches, 0);
});

test('创建超时保留未知结果且不自动重发；同一稳定键由上层显式恢复', async () => {
  const f = fixture(() => undefined, 10);
  try {
    await assert.rejects(f.client.create(params), error => error.code === 'HOST_PROJECT_RESULT_UNKNOWN' && error.resultUnknown === true);
    assert.equal(f.requests.filter(r => r.method === 'project/create').length, 1);
  } finally { f.client.close(); }
});

test('失联创建为未知，明确 JSON-RPC 拒绝保留错误码且不当作未知成功', async () => {
  const dropped = fixture((_, child) => { child.emit('exit', 1); return undefined; });
  try { await assert.rejects(dropped.client.create(params), error => error.resultUnknown === true); }
  finally { dropped.client.close(); }
  const rejected = fixture(() => ({ error: { code: -32601, message: 'method not found' } }));
  try {
    await assert.rejects(rejected.client.create(params), error => error.code === 'HOST_PROJECT_REQUEST_REJECTED' && error.rpcCode === -32601 && error.resultUnknown === false);
    assert.equal(rejected.requests.filter(r => r.method === 'project/create').length, 1);
  } finally { rejected.client.close(); }
});

test('环境清理不改原对象；describe 无副作用并明确不能单凭协议证明侧栏', async () => {
  const source = { PATH: 'tools', CODEX_THREAD_ID: 'parent', CODEX_SESSION_ID: 'parent', CODEX_WINDOWS_REGISTERED_CORE: '1' };
  assert.deepEqual(projectEnvironment(source), { PATH: 'tools' }); assert.equal(source.CODEX_THREAD_ID, 'parent');
  const description = await hostProjectCli(['describe']); assert.equal(description.experimentalApi, true);
  assert.deepEqual(description.methods, ['project/list', 'project/create', 'project/read']);
  assert.match(description.limitation, /list_projects verification/);
});
