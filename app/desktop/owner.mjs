import path from 'node:path';
import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, HttpError } from '../server/index.mjs';

const root = process.env.WORKBENCH_DATA_DIR;
const token = process.env.WORKBENCH_SESSION_TOKEN;
const generation = randomUUID();
if (!root || !path.isAbsolute(root) || !token || token.length < 64) throw Error('Invalid private runtime configuration');
const discovery = path.join(root, 'owner.json');
const stopped = path.join(root, 'stopped.json');
const expected = Buffer.from(`Bearer ${token}`);
let shuttingDown = false;
function authorize(req, pathname) {
  if (shuttingDown) throw new HttpError(503, 'STOPPED');
  // 插件凭据由轻量授权表校验，桌面会话令牌仍只开放私有 UI。
  if (pathname === '/api/light-mcp') return;
  const actual = Buffer.from(req.headers.authorization ?? '');
  const duplicates = req.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === 'authorization').length;
  if (duplicates !== 1 || actual.length !== expected.length || !timingSafeEqual(actual, expected) || req.headers.origin !== undefined) {
    throw new HttpError(403, 'FORBIDDEN');
  }
  if (shuttingDown) throw new HttpError(503, 'STOPPED');
}
await mkdir(root, { recursive: true });
// Only explicit desktop startup invokes this entry. A bridge never launches it.
const server = await createServer({ dataDir: root, env: {}, authorize, lightAccessEnabled: true });
await unlink(stopped).catch(e => { if (e.code !== 'ENOENT') throw e; });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const record = { version: 1, ownerGeneration: generation, pid: process.pid, endpoint: `http://127.0.0.1:${server.address().port}`, nodeVersion: process.versions.node };
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
  const current = JSON.parse(await readFile(discovery, 'utf8'));
  if (current.ownerGeneration === generation) await unlink(discovery);
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => { if (data.trim() === 'stop') stop().then(() => process.exit(0)); });
process.stdin.on('end', () => stop().then(() => process.exit(0)));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop().then(() => process.exit(0)));
