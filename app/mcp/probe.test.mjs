import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createProbeOwner } from './probe-owner.mjs';
import { createProbeFixture } from './probe-fixture.mjs';
import { contract, validatorFor } from './contracts.mjs';

test('九工具冻结 schema 全部可编译，拒绝多余权限字段及缺失身份', () => {
  const names = Object.keys(contract.$defs).filter(name => name.endsWith('_input'));
  assert.equal(names.length, 9);
  for (const name of names) {
    const tool = name.slice(0, -6);
    const input = validatorFor(tool, 'input');
    assert.equal(input({}), false, tool);
    assert.equal(input({ projectId: 'P', reviewer: 'admin', sourceTrust: 'hostObserved' }), false, tool);
    assert.equal(validatorFor(tool, 'output')({ status: 'accepted', result: {} }), false, tool);
  }
});

test('真实 STDIO initialize/list/call、范围、错误输入、凭据、断线与只读性', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), '工作台 MCP U01 '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const projectId = await createProbeFixture(dataDir);
  const token = randomBytes(32).toString('hex');
  const owner = await createProbeOwner({ dataDir, projectId, token });
  await new Promise(resolve => owner.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => owner.close(resolve)));
  const endpoint = `http://127.0.0.1:${owner.address().port}`;
  const configFile = path.join(root, '探测配置.json');
  await writeFile(configFile, JSON.stringify({ endpoint, projectId, token }));
  const transcript = [];
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [process.env.U01_PROBE_ENTRY ?? fileURLToPath(new URL('./stdio.mjs', import.meta.url))],
    env: { WORKBENCH_PROBE_CONFIG: configFile }, stderr: 'pipe' });
  const originalSend = transport.send.bind(transport);
  let diagnostics = '';
  transport.stderr.on('data', chunk => { diagnostics += chunk; });
  transport.send = async message => { transcript.push({ direction: 'request', message }); return originalSend(message); };
  const originalStart = transport.start.bind(transport);
  transport.start = async () => {
    const originalMessage = transport.onmessage;
    transport.onmessage = (message, extra) => { transcript.push({ direction: 'response', message }); originalMessage(message, extra); };
    await originalStart();
  };
  const client = new Client({ name: 'u01-protocol-test', version: '0.1.0' });
  t.after(() => client.close());
  await client.connect(transport, { timeout: 10000 });
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name), ['workbench_get_project']);
  const modelFile = path.join(dataDir, 'models', `${projectId}.json`);
  const before = await readFile(modelFile, 'utf8');
  const call = args => client.callTool({ name: 'workbench_get_project', arguments: args });
  const response = await call({ projectId });
  assert.equal(response.structuredContent.result.project.projectId, projectId);
  assert.equal(response.structuredContent.result.project.name, 'U01 隔离读取样例');
  assert.equal(response.structuredContent.basisRevision, 1);
  assert.equal(response.structuredContent.sourceTrust, 'declared');
  assert.deepEqual(response.structuredContent.supportedCapabilities, ['project.read.probe']);
  assert.equal(validatorFor('workbench_get_project', 'output')(response.structuredContent), true);
  assert.equal((await call({ projectId: 'other' })).structuredContent.error.code, 'FORBIDDEN');
  await assert.rejects(call({ projectId, sourceTrust: 'hostObserved' }), /Invalid|invalid/);
  await assert.rejects(call({ projectId, query: { requestId: 'not-implemented' } }), /unsupported/);
  await assert.rejects(client.callTool({ name: 'workbench_record_start', arguments: {} }), /Unsupported/);
  assert.equal((await fetch(`${endpoint}/probe/projects/${projectId}`)).status, 403);
  assert.equal((await fetch(`${endpoint}/probe/projects/other`, { headers: { Authorization: `Bearer ${token}` } })).status, 404);
  assert.equal((await fetch(`${endpoint}/probe/projects/${projectId}`, { headers: { Authorization: `Bearer ${token}`, Origin: 'http://127.0.0.1' } })).status, 403);
  assert.equal(await readFile(modelFile, 'utf8'), before);
  await new Promise(resolve => owner.close(resolve));
  assert.equal((await call({ projectId })).structuredContent.error.code, 'OWNER_UNAVAILABLE');
  assert.equal(diagnostics, '', 'Successful probe must not emit startup failure diagnostics');
  if (process.env.U01_EVIDENCE_DIR) {
    await writeFile(path.join(process.env.U01_EVIDENCE_DIR, 'mcp-protocol.json'), JSON.stringify({
      date: '2026-11-09', client: 'self-built SDK client', serverVersion: client.getServerVersion(),
      serverCapabilities: client.getServerCapabilities(), transcript,
    }, null, 2));
  }
});

test('缺失配置启动失败，诊断不泄露配置及凭据', async () => {
  const client = new Client({ name: 'u01-start-failure', version: '0.1.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('./stdio.mjs', import.meta.url))], env: { WORKBENCH_PROBE_CONFIG: '' }, stderr: 'pipe' });
  let diagnostics = '';
  transport.stderr.on('data', chunk => { diagnostics += chunk; });
  await assert.rejects(client.connect(transport, { timeout: 10000 }));
  await client.close();
  assert.match(diagnostics, /failed to start/);
});
