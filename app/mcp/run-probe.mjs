import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { createProbeFixture } from './probe-fixture.mjs';
import { createProbeOwner } from './probe-owner.mjs';

const root = path.resolve(process.argv[2] ?? '');
if (!process.argv[2] || !path.isAbsolute(process.argv[2])) throw new Error('Pass a new absolute evidence directory');
await mkdir(root, { recursive: true });
const dataDir = path.join(root, 'data');
let projectId;
try {
  const previous = JSON.parse(await readFile(path.join(root, 'owner-info.json'), 'utf8'));
  if (previous.dataDir !== dataDir || !previous.projectId) throw new Error('Probe directory identity mismatch');
  projectId = previous.projectId;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  projectId = await createProbeFixture(dataDir);
}
const token = randomBytes(32).toString('hex');
const owner = await createProbeOwner({ dataDir, projectId, token,
  audit: event => { appendFile(path.join(root, 'owner-audit.jsonl'), JSON.stringify(event) + '\n').catch(() => {}); },
});
await new Promise((resolve, reject) => { owner.once('error', reject); owner.listen(0, '127.0.0.1', resolve); });
const endpoint = `http://127.0.0.1:${owner.address().port}`;
await writeFile(path.join(root, 'probe-config.json'), JSON.stringify({ endpoint, projectId, token }, null, 2), { mode: 0o600 });
await writeFile(path.join(root, 'owner-info.json'), JSON.stringify({ date: '2026-11-09', pid: process.pid, dataDir, projectId, endpoint }, null, 2));
console.log(JSON.stringify({ ready: true, projectId, dataDir, config: path.join(root, 'probe-config.json') }));
process.once('SIGINT', () => owner.close());
process.once('SIGTERM', () => owner.close());
