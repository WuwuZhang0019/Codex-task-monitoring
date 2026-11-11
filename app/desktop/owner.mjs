import path from 'node:path';
import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { preparePrivateDirectory, writePrivateJson } from './private-runtime.mjs';
import { createServer, HttpError } from '../server/index.mjs';
import { acquireDataLease } from '../server/data-lease.mjs';

const root = process.env.WORKBENCH_DATA_DIR;
const token = process.env.WORKBENCH_SESSION_TOKEN;
const generation = randomUUID();
if (!root || !path.isAbsolute(root) || !token || token.length < 64) throw Error('Invalid private runtime configuration');
const discovery = path.join(root, 'owner.json');
const stopped = path.join(root, 'stopped.json');
const expected = Buffer.from(`Bearer ${token}`);
const panelToken = randomBytes(32).toString('hex');
const panelExpected = Buffer.from(`Bearer ${panelToken}`);
const privateDirectory = path.join(root, 'runtime-private');
let shuttingDown = false;
function authorize(req, pathname) {
  if (shuttingDown) throw new HttpError(503, 'STOPPED');
  // 插件凭据由轻量授权表校验，桌面会话令牌仍只开放私有 UI。
  if (pathname === '/api/light-mcp') return;
  const actual = Buffer.from(req.headers.authorization ?? '');
  const duplicates = req.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === 'authorization').length;
  const manager = actual.length === expected.length && timingSafeEqual(actual, expected);
  const panel = actual.length === panelExpected.length && timingSafeEqual(actual, panelExpected)
    && req.url === pathname && ((pathname === '/api/light-panel' && req.method === 'GET')
      || (pathname === '/api/light-panel/preferences' && req.method === 'PUT'));
  if (duplicates !== 1 || (!manager && !panel) || req.headers.origin !== undefined) {
    throw new HttpError(403, 'FORBIDDEN');
  }
  if (shuttingDown) throw new HttpError(503, 'STOPPED');
}
await mkdir(root, { recursive: true });
// Date: 2026-11-12. Only explicit desktop/service startup invokes this entry; bridges never launch it.
await preparePrivateDirectory(privateDirectory);
// Keep generation/session cleanup serialized even after the HTTP server releases its business lease.
const releaseLifecycle = acquireDataLease(privateDirectory);
const server = await createServer({ dataDir: root, env: {}, authorize, lightAccessEnabled: true });
await writePrivateJson(path.join(privateDirectory, 'owner-session.json'), { version: 1, ownerGeneration: generation, token });
await writePrivateJson(path.join(privateDirectory, 'panel-session.json'), { version: 1, ownerGeneration: generation, token: panelToken });
await unlink(stopped).catch(e => { if (e.code !== 'ENOENT') throw e; });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const record = { version: 1, ownerGeneration: generation, pid: process.pid, endpoint: `http://127.0.0.1:${server.address().port}`, nodeVersion: process.versions.node, lifetime: process.env.WORKBENCH_OWNER_MODE === 'standalone' ? 'standalone' : 'desktop' };
await writeFile(`${discovery}.tmp`, JSON.stringify(record), { mode: 0o600 });
await rename(`${discovery}.tmp`, discovery);
console.log(JSON.stringify({ ready: true, ...record }));
let stopping;
function stop() {
  if (stopping) return stopping;
  shuttingDown = true;
  stopping = drainAndStop();
  return stopping;
}
async function drainAndStop() {
  await writeFile(stopped, JSON.stringify({ ownerGeneration: generation, stoppedAt: new Date().toISOString(), reason: 'explicitExit' }), { mode: 0o600 });
  server.closeIdleConnections();
  await new Promise(resolve => server.close(resolve));
  const current = JSON.parse(await readFile(discovery, 'utf8').catch(() => 'null'));
  if (current?.ownerGeneration === generation) {
    await unlink(discovery);
    for (const name of ['owner-session.json', 'panel-session.json', 'control.json']) {
      await unlink(path.join(privateDirectory, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  releaseLifecycle();
}
if (process.env.WORKBENCH_OWNER_MODE !== 'standalone') {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', data => { if (data.trim() === 'stop') stop().then(() => process.exit(0)); });
  process.stdin.on('end', () => stop().then(() => process.exit(0)));
}
// The explicit service CLI writes this protected, generation-bound control request.
let checking = false;
setInterval(async () => {
  if (checking || shuttingDown) return;
  checking = true;
  try {
    const request = JSON.parse(await readFile(path.join(privateDirectory, 'control.json'), 'utf8'));
    const supplied = Buffer.from(`Bearer ${request.token ?? ''}`);
    if (request.action === 'stop' && request.ownerGeneration === generation
      && supplied.length === expected.length && timingSafeEqual(supplied, expected)) {
      await stop();
      process.exit(0);
    }
  } catch (error) { if (error.code !== 'ENOENT') console.error('Invalid runtime control request'); }
  finally { checking = false; }
}, 250);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop().then(() => process.exit(0)));
