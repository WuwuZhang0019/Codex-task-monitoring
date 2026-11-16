// Date: 2026-11-16. Isolated launcher records; no installed user application is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createIslandRecovery, registerLauncher } from './island-launcher.mjs';

test('cold startup is coalesced across independent callers and reuses a live island', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'island-launch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'launcher.json');
  const record = { version: 1, executable: process.execPath, dataDir: root, pid: 99999999 };
  await writeFile(file, JSON.stringify(record));
  let started = 0, ready = false;
  const check = async () => { if (!ready) throw Error('OWNER_UNAVAILABLE'); return { generation: 'new' }; };
  const launch = async () => { started++; await new Promise(resolve => setTimeout(resolve, 40)); await writeFile(file, JSON.stringify({ ...record, pid: process.pid })); ready = true; };
  const options = { file, dataDir: root, launch, timeoutMs: 1000, intervalMs: 10 };
  const a = createIslandRecovery(options), b = createIslandRecovery(options);
  const result = await Promise.all([a.ensure(check), a.ensure(check), b.ensure(check)]);
  assert.deepEqual(result, Array(3).fill({ generation: 'new' }));
  await a.ensure(check);
  assert.equal(started, 1);
});

test('missing installation, wrong data root and invalid records never launch arbitrary commands', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'island-launch-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'launcher.json');
  let starts = 0;
  const recovery = createIslandRecovery({ file, dataDir: root, launch: async () => { starts++; } });
  const check = async () => { throw Error('OWNER_UNAVAILABLE'); };
  await assert.rejects(recovery.ensure(check), /ISLAND_LAUNCHER_MISSING/);
  for (const value of [ { version: 1, executable: 'cmd.exe', dataDir: root, pid: 1 },
    { version: 1, executable: process.execPath, dataDir: path.dirname(root), pid: 1 },
    { version: 1, executable: process.execPath, dataDir: root, pid: -1 } ]) {
    await writeFile(file, JSON.stringify(value));
    await assert.rejects(recovery.ensure(check), /ISLAND_LAUNCHER_INVALID/);
  }
  assert.equal(starts, 0);
});

test('a live owner without launcher is usable; revoked authorization never causes startup', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'island-launch-live-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const recovery = createIslandRecovery({ file: path.join(root, 'missing.json') });
  assert.equal(await recovery.ensure(async () => 'ready'), 'ready');
  await assert.rejects(recovery.ensure(async () => { throw Error('FORBIDDEN'); }), /FORBIDDEN/);
});

test('native registration persists only installation metadata and startup timeout releases its lock', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'island-launch-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'launcher.json');
  await registerLauncher(file, { executable: process.execPath, dataDir: root, pid: process.pid });
  const record = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(record.executable, process.execPath);
  assert.equal(Object.hasOwn(record, 'token'), false);
  const recovery = createIslandRecovery({ file, timeoutMs: 70, intervalMs: 5, launch: async () => {} });
  await assert.rejects(recovery.ensure(async () => { throw Error('OWNER_UNAVAILABLE'); }), /ISLAND_START_TIMEOUT/);
  await assert.rejects(readFile(`${file}.starting`), { code: 'ENOENT' });
});
