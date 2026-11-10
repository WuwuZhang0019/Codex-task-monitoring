// 日期：2026-11-10。随包 Node/服务发布烟测，PATH 仅保留 Windows 系统目录。
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { draftInput } from './helpers/u03-fixture.mjs';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(app, 'test-results/manual-trial/U03-EX01');
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(output, 'packaged-data-'));
const runtime = path.join(app, 'desktop/resources');
const token = randomBytes(32).toString('hex');
const child = spawn(path.join(runtime, 'node.exe'), [path.join(runtime, 'app/desktop/owner.mjs')], {
  cwd: path.join(runtime, 'app'), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  env: { SystemRoot: process.env.SystemRoot, USERPROFILE: process.env.USERPROFILE, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PATH: path.join(process.env.SystemRoot, 'System32'), WORKBENCH_DATA_DIR: root, WORKBENCH_SESSION_TOKEN: token },
});
let diagnostics = '';
child.stderr.on('data', data => { diagnostics += data; });
child.stdout.resume();
try {
  let record;
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw Error(diagnostics);
    try { record = JSON.parse(await readFile(path.join(root, 'owner.json'), 'utf8')); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(record, 'Bundled owner startup timeout');
  const transcript = [];
  async function request(endpoint, body) {
    const response = await fetch(record.endpoint + '/api' + endpoint, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); transcript.push({ endpoint, status: response.status, result }); return result;
  }
  const draft = await request('/import-drafts', draftInput()); assert.equal(draft.status, 'ready');
  const invalid = draftInput(); invalid.candidate.receiptLog = {};
  const rejected = await fetch(record.endpoint + '/api/import-drafts', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(invalid) });
  assert.equal(rejected.status, 400, await rejected.text());
  const confirmation = await request(`/import-drafts/${draft.draftId}/confirm`, { revision: 1, expectedRevision: 0, acknowledged: true });
  const publication = await request(`/import-drafts/${draft.draftId}/publish`, { confirmationGrantId: confirmation.confirmationGrantId, confirmationDigest: confirmation.confirmationDigest, sourceHash: draft.source.sourceHash, idempotencyKey: 'packaged-publication' });
  const monitor = await request(`/projects/${publication.projectId}/monitor`); assert.equal(monitor.stations.length, 8);
  const exited = once(child, 'exit'); child.stdin.end('stop\n'); const [exitCode] = await exited; assert.equal(exitCode, 0, diagnostics);
  const stopped = JSON.parse(await readFile(path.join(root, 'stopped.json'), 'utf8')); assert.equal(stopped.reason, 'explicitExit');
  await writeFile(path.join(output, 'packaged-summary.json'), JSON.stringify({ date: '2026-11-10', root, nodeVersion: record.nodeVersion, exitCode, transcript, stopped }, null, 2));
  console.log('PASS bundled Node, schema validator, complete draft publication, monitor and explicit drain');
} finally { if (child.exitCode === null) child.kill(); }
