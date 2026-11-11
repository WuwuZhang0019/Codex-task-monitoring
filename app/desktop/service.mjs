// Date: 2026-11-12. Explicit standalone lifecycle; MCP and UI readers never auto-start this service.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { open, mkdir, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { connectOwner, discoverOwner } from './client.mjs';
import { writePrivateJson } from './private-runtime.mjs';
import { acquireDataLease } from '../server/data-lease.mjs';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function startService(dataDir) {
  if (!path.isAbsolute(dataDir)) throw Error('ABSOLUTE_DATA_DIR_REQUIRED');
  let existing;
  try { existing = (await connectOwner(dataDir)).record; } catch {}
  if (existing) {
    if (existing.lifetime !== 'standalone') throw Error('DESKTOP_OWNER_ACTIVE: exit the old desktop before explicitly starting the standalone service');
    return { ...existing, attached: true };
  }
  await mkdir(dataDir, { recursive: true });
  const log = await open(path.join(dataDir, 'service-runtime.log'), 'a', 0o600);
  const env = { ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_SESSION_TOKEN: randomBytes(32).toString('hex'), WORKBENCH_OWNER_MODE: 'standalone' };
  delete env.NODE_OPTIONS;
  const child = spawn(process.execPath, [fileURLToPath(new URL('./owner.mjs', import.meta.url))], {
    env, detached: true, stdio: ['ignore', log.fd, log.fd], windowsHide: true,
  });
  let failure;
  child.once('error', error => { failure = error; });
  child.unref();
  await log.close();
  for (let i = 0; i < 100; i++) {
    try { return { ...(await connectOwner(dataDir)).record, attached: false }; } catch {}
    if (failure) throw Error('SERVICE_SPAWN_FAILED', { cause: failure });
    if (child.exitCode !== null) throw Error('SERVICE_START_FAILED: inspect service-runtime.log');
    await pause(100);
  }
  throw Error('SERVICE_START_TIMEOUT: inspect service-runtime.log');
}
export async function stopService(dataDir) {
  const { record, token } = await connectOwner(dataDir);
  await writePrivateJson(path.join(dataDir, 'runtime-private/control.json'), {
    action: 'stop', ownerGeneration: record.ownerGeneration, token,
  });
  for (let i = 0; i < 300; i++) {
    try {
      const current = await discoverOwner(dataDir);
      if (current.ownerGeneration !== record.ownerGeneration) throw Error('OWNER_CHANGED_DURING_STOP');
    } catch (error) {
      if (error.message === 'STOPPED' || error.code === 'ENOENT') {
        // stopped.json is written before draining; wait until discovery is removed as well.
        try {
          await readFile(path.join(dataDir, 'owner.json'));
        } catch (missing) {
          if (missing.code !== 'ENOENT') throw missing;
          try {
            const release = acquireDataLease(path.join(dataDir, 'runtime-private'));
            release();
            return { stopped: true, ownerGeneration: record.ownerGeneration };
          } catch (lease) { if (!lease.message.startsWith('DATA_ROOT_BUSY')) throw lease; }
        }
      } else throw error;
    }
    await pause(100);
  }
  throw Error('SERVICE_STOP_TIMEOUT: accepted requests may still be draining');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, flag, dataDir, ...extra] = process.argv.slice(2);
    if (!['start', 'stop', 'status'].includes(action) || flag !== '--data-dir' || !dataDir || !path.isAbsolute(dataDir) || extra.length) {
      throw Error('Usage: node desktop/service.mjs start|stop|status --data-dir <absolute-directory>');
    }
    const result = action === 'start' ? await startService(dataDir) : action === 'stop'
      ? await stopService(dataDir) : (await connectOwner(dataDir)).record;
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
