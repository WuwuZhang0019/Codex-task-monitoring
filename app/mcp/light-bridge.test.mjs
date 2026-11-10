// 日期 2026-11-10。真实 STDIO/HTTP 传输测试，所有者使用独立模拟端点。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLightBridge, loadLightConfig } from './light-bridge.mjs';
import { lightTools } from './light.mjs';

const entry = process.env.D_LIGHT_BRIDGE_ENTRY ?? fileURLToPath(new URL('./light-stdio.mjs', import.meta.url));
const base = { schemaVersion: 'light-1.0', projectId: 'fixture-project', planId: 'fixture-plan', expectedRevision: 0,
  eventId: 'transport-event', source: { path: 'fixture.md', version: '2026-11-10', sha256: 'a'.repeat(64), locator: 'fixture' },
  occurredAt: '2026-11-10T23:00:00+08:00', reason: 'transport fixture' };
function result(value) { return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }; }

test('D bridge 配置限制为私有回环与独立令牌', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'light-bridge-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.json');
  const valid = { endpoint: 'http://127.0.0.1:43180', token: randomBytes(32).toString('hex') };
  await writeFile(file, JSON.stringify(valid));
  assert.deepEqual(await loadLightConfig(file), valid);
  const discoveryConfig = { dataDir: root, token: valid.token };
  await writeFile(file, JSON.stringify(discoveryConfig));
  assert.deepEqual(await loadLightConfig(file), discoveryConfig);
  await assert.rejects(loadLightConfig('relative.json'), /LIGHT_CONFIG_REQUIRED/);
  for (const change of [
    { endpoint: 'https://127.0.0.1:43180' }, { endpoint: 'http://localhost:43180' },
    { endpoint: 'http://127.0.0.1:43180/path' }, { endpoint: 'http://user@127.0.0.1:43180' },
    { endpoint: 'http://127.0.0.1:43180?token=secret' }, { endpoint: 'http://127.0.0.1:43180#secret' },
    { token: 'short' }, { token: 'z'.repeat(64) }, { principal: 'admin' }, { dataDir: root },
  ]) {
    await writeFile(file, JSON.stringify({ ...valid, ...change }));
    await assert.rejects(loadLightConfig(file));
  }
  await writeFile(file, JSON.stringify({ dataDir: 'relative', token: valid.token }));
  await assert.rejects(loadLightConfig(file), /LIGHT_CONFIG_INVALID/);
});

test('D bridge 真实 STDIO 发现转发、写入响应丢失后原键查询、拒绝重定向及断线脱敏', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'light-bridge-stdio-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = randomBytes(32).toString('hex');
  const transcript = [];
  let mode = 'normal', writes = 0, forwarded = 0;
  const committed = new Map();
  const owner = http.createServer(async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    assert.equal(req.url, '/api/light-mcp');
    const authenticated = req.headers.authorization === `Bearer ${token}`;
    transcript.push({ direction: 'owner-request', method: req.method, authenticated });
    if (!authenticated || mode === 'forbidden') return json(403, { error: 'FORBIDDEN' });
    if (mode === 'redirect') { res.writeHead(307, { Location: `http://127.0.0.1:${redirectTarget.address().port}/capture` }); return res.end(); }
    if (req.method === 'GET') return json(200, { tools: lightTools });
    let text = ''; for await (const chunk of req) text += chunk;
    const call = JSON.parse(text);
    transcript.push({ direction: 'owner-call', name: call.name, arguments: call.arguments });
    if (call.name === 'workbench_reserve_execution') {
      writes += 1;
      const value = result({ schemaVersion: 'light-1.0', status: 'accepted', result: { state: 'committed', eventId: call.arguments.eventId, committedRevision: 1 } });
      committed.set(call.arguments.eventId, value);
      if (mode === 'drop') return req.socket.destroy();
      return json(200, value);
    }
    if (call.name === 'workbench_query_event') return json(200, committed.get(call.arguments.eventId));
    return json(200, result({ schemaVersion: 'light-1.0', status: 'accepted', result: { projectId: call.arguments.projectId } }));
  });
  const redirectTarget = http.createServer((_req, res) => { forwarded += 1; res.end('{}'); });
  for (const server of [owner, redirectTarget]) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
  }
  const endpoint = `http://127.0.0.1:${owner.address().port}`;
  const file = path.join(root, 'config.json');
  await writeFile(file, JSON.stringify({ endpoint, token }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: { WORKBENCH_LIGHT_CONFIG: file }, stderr: 'pipe' });
  let diagnostics = '';
  transport.stderr.on('data', data => { diagnostics += data; });
  const client = new Client({ name: 'light-bridge-stdio-fixture', version: '0.1.0' });
  t.after(() => client.close());
  await client.connect(transport, { timeout: 10000 });
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name), lightTools.map(tool => tool.name));
  const call = (name, args) => client.callTool({ name, arguments: args });
  assert.equal((await call('workbench_get_project', { projectId: 'fixture-project' })).structuredContent.result.projectId, 'fixture-project');
  await assert.rejects(call('unsupported_tool', {}), /Unsupported/);
  mode = 'drop';
  const unknown = await call('workbench_reserve_execution', base);
  assert.equal(unknown.structuredContent.status, 'unknown');
  assert.equal(unknown.structuredContent.error.code, 'UNKNOWN_RESULT');
  assert.equal(unknown.structuredContent.error.recovery, 'queryOriginalEventBeforeRetry');
  assert.equal(writes, 1, '桥不自动重发可能已经提交的写入');
  mode = 'normal';
  const queried = await call('workbench_query_event', { projectId: base.projectId, operation: 'reserveExecution', eventId: base.eventId });
  assert.equal(queried.structuredContent.result.state, 'committed'); assert.equal(writes, 1);
  mode = 'forbidden';
  assert.equal((await call('workbench_reserve_execution', base)).structuredContent.error.code, 'FORBIDDEN');
  mode = 'redirect';
  assert.equal((await call('workbench_reserve_execution', base)).structuredContent.error.code, 'UNKNOWN_RESULT');
  assert.equal(forwarded, 0, '凭据不会跟随重定向');
  await new Promise(resolve => { owner.closeAllConnections(); owner.close(resolve); });
  const unavailable = await call('workbench_get_project', { projectId: base.projectId });
  assert.equal(unavailable.structuredContent.error.code, 'OWNER_UNAVAILABLE');
  await assert.rejects(client.listTools(), /OWNER_UNAVAILABLE/);
  assert.equal(diagnostics, '');
  assert.equal(JSON.stringify({ transcript, unknown, queried, unavailable }).includes(token), false);
  if (process.env.D_EVIDENCE_DIR) {
    await mkdir(process.env.D_EVIDENCE_DIR, { recursive: true });
    await writeFile(path.join(process.env.D_EVIDENCE_DIR, 'bridge-stdio.json'), JSON.stringify({
      date: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date()),
      environment: 'SDK STDIO subprocess and actual loopback HTTP fixture, no host business authorization',
      entry, runtimeSha256: createHash('sha256').update(await readFile(entry)).digest('hex'), transcript,
      writes, unknown, queried, unavailable, redirectedRequests: forwarded, diagnostics }, null, 2), 'utf8');
  }
});

test('D bridge 写请求超时保持未知且没有自动重试', async t => {
  let writes = 0;
  const owner = http.createServer(async req => { for await (const _chunk of req) { /* 消费输入但不发送响应。 */ } writes += 1; });
  await new Promise(resolve => owner.listen(0, '127.0.0.1', resolve));
  t.after(() => { owner.closeAllConnections(); owner.close(); });
  const server = createLightBridge({ endpoint: `http://127.0.0.1:${owner.address().port}`, token: randomBytes(32).toString('hex') }, { writeTimeoutMs: 250 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'light-timeout-fixture', version: '0.1.0' });
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const response = await client.callTool({ name: 'workbench_reserve_execution', arguments: base });
  assert.equal(response.structuredContent.error.code, 'UNKNOWN_RESULT'); assert.equal(writes, 1);
});

test('D bridge 缺少配置启动失败且诊断隐藏私有路径', async () => {
  const client = new Client({ name: 'light-start-failure', version: '0.1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: { WORKBENCH_LIGHT_CONFIG: '' }, stderr: 'pipe' });
  let diagnostics = '';
  transport.stderr.on('data', data => { diagnostics += data; });
  await assert.rejects(client.connect(transport, { timeout: 10000 }));
  await client.close();
  assert.equal(diagnostics.trim(), 'Workbench light bridge failed to start. Check the private owner configuration.');
});

test('D bridge 同一连接跟随dataDir所有者端口与generation变化，显式停止拒绝连接', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'light-bridge-discovery-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const token = randomBytes(32).toString('hex');
  let requests = 0;
  const owners = ['generation-A', 'generation-B'].map(generation => http.createServer(async (req, res) => {
    requests += 1;
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    let text = ''; for await (const chunk of req) text += chunk;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result({ schemaVersion: 'light-1.0', status: 'accepted', result: { generation } })));
  }));
  for (const owner of owners) {
    await new Promise(resolve => owner.listen(0, '127.0.0.1', resolve));
    t.after(() => { owner.closeAllConnections(); owner.close(); });
  }
  const updateOwner = (index) => writeFile(path.join(dataDir, 'owner.json'), JSON.stringify({ version: 1,
    endpoint: `http://127.0.0.1:${owners[index].address().port}`, ownerGeneration: `generation-${index ? 'B' : 'A'}` }));
  await updateOwner(0);
  const server = createLightBridge({ dataDir, token });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'light-discovery-fixture', version: '0.1.0' });
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const call = () => client.callTool({ name: 'workbench_get_project', arguments: { projectId: 'fixture' } });
  assert.equal((await call()).structuredContent.result.generation, 'generation-A');
  await updateOwner(1);
  assert.equal((await call()).structuredContent.result.generation, 'generation-B');
  await writeFile(path.join(dataDir, 'stopped.json'), JSON.stringify({ reason: 'explicitExit' }));
  assert.equal((await call()).structuredContent.error.code, 'OWNER_UNAVAILABLE');
  assert.equal(requests, 2, '显式停止后不向任一旧所有者发请求');
});
