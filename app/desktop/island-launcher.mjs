// Date: 2026-11-16. Only a native-registered local installation may be launched.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFile, stat, open, unlink } from 'node:fs/promises';
import { preparePrivateDirectory, writePrivateJson } from './private-runtime.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const normalized = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
function outage(error) {
  return error.code === 'ENOENT' || ['STOPPED', 'OWNER_UNAVAILABLE', 'fetch failed'].includes(error.message)
    || ['TimeoutError', 'AbortError'].includes(error.name);
}
export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}
export async function readLauncher(file, dataDir) {
  const value = JSON.parse(await readFile(file, 'utf8'));
  if (value.version !== 1 || !path.isAbsolute(value.executable ?? '') || !path.isAbsolute(value.dataDir ?? '')
    || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || (dataDir && normalized(value.dataDir) !== normalized(dataDir))
    || !(await stat(value.executable)).isFile()) throw Error('ISLAND_LAUNCHER_INVALID');
  return value;
}
export async function registerLauncher(file, { executable, dataDir, pid }) {
  if (!path.isAbsolute(file)) throw Error('ISLAND_LAUNCHER_INVALID');
  const value = { version: 1, executable, dataDir, pid, registeredAt: new Date().toISOString() };
  if (!path.isAbsolute(executable ?? '') || !path.isAbsolute(dataDir ?? '') || !processAlive(pid)
    || !(await stat(executable)).isFile()) throw Error('ISLAND_LAUNCHER_INVALID');
  await preparePrivateDirectory(path.dirname(file));
  await writePrivateJson(file, value);
}
async function launchInstalled(record) {
  await new Promise((resolve, reject) => {
    const env = { ...process.env, ISLAND_WORKBENCH_DATA_DIR: record.dataDir };
    delete env.NODE_OPTIONS;
    const child = spawn(record.executable, ['--workbench-recover'], {
      detached: true, windowsHide: true, stdio: 'ignore', env,
    });
    child.once('error', () => reject(Error('ISLAND_START_FAILED')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
export function createIslandRecovery({ file, dataDir, timeoutMs = 20000, intervalMs = 100,
  launch = launchInstalled, alive = processAlive } = {}) {
  let flight;
  async function ensure(check) {
    let ready;
    try { ready = await check(); } catch (error) { if (!outage(error)) throw error; }
    if (!ready && dataDir) {
      const pending = path.join(dataDir, 'runtime-private', 'upgrade.json');
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        try { await stat(pending); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
        if (Date.now() >= deadline) throw Error('OWNER_UNAVAILABLE');
        await pause(intervalMs);
        try { return await check(); } catch (error) { if (!outage(error)) throw error; }
      }
    }
    let record;
    try { record = await readLauncher(file, dataDir); }
    catch (error) {
      if (ready && error.code === 'ENOENT') return ready;
      throw Error(error.code === 'ENOENT' ? 'ISLAND_LAUNCHER_MISSING' : 'ISLAND_LAUNCHER_INVALID');
    }
    if (ready && alive(record.pid)) return ready;
    const deadline = Date.now() + timeoutMs;
    const lockFile = `${file}.starting`;
    let lock;
    while (Date.now() < deadline) {
      try { lock = await open(lockFile, 'wx', 0o600); await lock.writeFile(JSON.stringify({ pid: process.pid })); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw Error('ISLAND_START_FAILED');
        try {
          const previous = JSON.parse(await readFile(lockFile, 'utf8'));
          if (!alive(previous.pid) || Date.now() - (await stat(lockFile)).mtimeMs > timeoutMs * 2) {
            await unlink(lockFile); continue;
          }
        } catch (error) { if (error.code === 'ENOENT') continue; }
        await pause(intervalMs);
      }
    }
    if (!lock) throw Error('ISLAND_START_TIMEOUT');
    try {
      record = await readLauncher(file, dataDir);
      try { ready = await check(); } catch (error) { ready = null; if (!outage(error)) throw error; }
      if (ready && alive(record.pid)) return ready;
      await launch(record);
      while (Date.now() < deadline) {
        try { return await check(); } catch (error) { if (!outage(error)) throw error; }
        await pause(intervalMs);
      }
      throw Error('ISLAND_START_TIMEOUT');
    } finally { await lock.close(); await unlink(lockFile).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  return { ensure(check) {
    if (!flight) flight = ensure(check).finally(() => { flight = null; });
    return flight;
  } };
}
