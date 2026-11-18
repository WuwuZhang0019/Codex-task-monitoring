// Date: 2026-11-16. Native island startup and recovery attach to one standalone owner.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { open, readFile, unlink } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { connectOwner, discoverOwner } from './client.mjs';
import { preparePrivateDirectory, writePrivateJson } from './private-runtime.mjs';
import { registerLauncher } from './island-launcher.mjs';
import os from 'node:os';
import { acquireDataLease } from '../server/data-lease.mjs';
import { liveUpdateProtocol, restoreCodexEnvironment } from './runtime-protocol.mjs';
import { bundledRelease, checkedRelease, readRuntimeJson, stageRelease } from './runtime-release.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const privateDir = dataDir => path.join(dataDir, 'runtime-private');
const upgradeFile = dataDir => path.join(privateDir(dataDir), 'upgrade.json');
const releaseFile = dataDir => path.join(privateDir(dataDir), 'release.json');
const exitResult = dataDir => path.join(privateDir(dataDir), 'exit-result.json');
const controlFile = dataDir => path.join(privateDir(dataDir), 'control.json');
const remove = file => unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });

function tryLease(directory) {
  try { return acquireDataLease(directory); }
  catch (error) { if (!error.message.startsWith('DATA_ROOT_BUSY')) throw error; return null; }
}
async function manage(dataDir, operation) {
  if (!path.isAbsolute(dataDir)) throw Error('ABSOLUTE_DATA_DIR_REQUIRED');
  await preparePrivateDirectory(privateDir(dataDir));
  const deadline = Date.now() + 30000;
  let release;
  while (!(release = tryLease(path.join(privateDir(dataDir), 'service-control')))) {
    if (Date.now() >= deadline) throw Error('SERVICE_OPERATION_BUSY');
    await pause(100);
  }
  try { return await operation(); } finally { release(); }
}
async function currentOwner(dataDir) {
  const owner = await connectOwner(dataDir).catch(() => null);
  if (owner && owner.record.lifetime !== 'standalone') {
    throw Error('DESKTOP_OWNER_ACTIVE: exit the old desktop before explicitly starting the standalone service');
  }
  return owner;
}
async function startOwner(dataDir, release, codexEnvironment) {
  const log = await open(path.join(dataDir, 'service-runtime.log'), 'a', 0o600);
  const env = { ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_SESSION_TOKEN: randomBytes(32).toString('hex'),
    WORKBENCH_OWNER_MODE: 'standalone', WORKBENCH_RUNTIME_ID: release.id };
  if (codexEnvironment) restoreCodexEnvironment(env, codexEnvironment);
  delete env.NODE_OPTIONS;
  const child = spawn(release.node, [release.entry], {
    env, detached: true, stdio: ['ignore', log.fd, log.fd], windowsHide: true,
  });
  let failure;
  child.once('error', error => { failure = error; });
  child.unref();
  await log.close();
  for (let i = 0; i < 100; i++) {
    const owner = await currentOwner(dataDir);
    if (owner?.record.pid === child.pid && owner.record.runtimeId === release.id) return { ...owner.record, attached: false };
    if (failure) throw Error('SERVICE_SPAWN_FAILED', { cause: failure });
    if (child.exitCode !== null || child.signalCode !== null) throw Error('SERVICE_START_FAILED: inspect service-runtime.log');
    await pause(100);
  }
  throw Error('SERVICE_START_TIMEOUT: inspect service-runtime.log');
}

async function finishUpgrade(dataDir, pending, owner) {
  if (pending.protocol !== liveUpdateProtocol) throw Error('INCOMPATIBLE_PENDING_UPGRADE');
  const from = checkedRelease(pending.from), to = checkedRelease(pending.to);
  let release = pending.rollback ? from : to;
  let record = owner?.record;
  if (record) {
    if (record.ownerGeneration === pending.sourceGeneration || record.runtimeId !== release.id
      || record.liveUpdateProtocol !== liveUpdateProtocol) throw Error('UNEXPECTED_OWNER_DURING_UPGRADE');
  } else {
    const replace = tryLease(privateDir(dataDir));
    if (!replace) throw Error('HANDOFF_STILL_DRAINING');
    replace();
    try { record = await startOwner(dataDir, release, pending.codexEnvironment); }
    catch (error) {
      // A timed-out process may still acquire the lease. Leave the durable request for recovery.
      if (pending.rollback || !/^SERVICE_(START_FAILED|SPAWN_FAILED)/.test(error.message)) throw error;
      pending.rollback = true;
      await writePrivateJson(upgradeFile(dataDir), pending);
      release = from;
      record = await startOwner(dataDir, release, pending.codexEnvironment);
    }
  }
  await writePrivateJson(releaseFile(dataDir), release);
  await remove(upgradeFile(dataDir));
  return { ...record, upgraded: !pending.rollback, rolledBack: !!pending.rollback };
}

export async function startService(dataDir) {
  if (!path.isAbsolute(dataDir)) throw Error('ABSOLUTE_DATA_DIR_REQUIRED');
  const existing = await currentOwner(dataDir);
  const pending = await readRuntimeJson(upgradeFile(dataDir));
  if (existing && (!pending || pending.sourceGeneration === existing.record.ownerGeneration)) {
    return { ...existing.record, attached: true };
  }
  return manage(dataDir, async () => {
    const owner = await currentOwner(dataDir);
    const pending = await readRuntimeJson(upgradeFile(dataDir));
    if (pending && pending.sourceGeneration !== owner?.record.ownerGeneration) return finishUpgrade(dataDir, pending, owner);
    if (owner) return { ...owner.record, attached: true };
    return startOwner(dataDir, checkedRelease(await readRuntimeJson(releaseFile(dataDir)) ?? await bundledRelease()));
  });
}

export function upgradeService(dataDir, runtimeDir) {
  return manage(dataDir, async () => {
    const owner = await currentOwner(dataDir);
    const pending = await readRuntimeJson(upgradeFile(dataDir));
    if (pending && pending.sourceGeneration !== owner?.record.ownerGeneration) return finishUpgrade(dataDir, pending, owner);
    if (!owner || owner.record.liveUpdateProtocol !== liveUpdateProtocol) throw Error('OWNER_LIVE_UPDATE_UNAVAILABLE');
    const from = checkedRelease(owner.release);
    const to = await stageRelease(privateDir(dataDir), runtimeDir);
    if (from.id === to.id) return { ...owner.record, upgraded: false, alreadyCurrent: true };
    if (pending && pending.to.id !== to.id) throw Error('ANOTHER_UPGRADE_PENDING');
    const upgrade = pending ?? {
      protocol: liveUpdateProtocol, id: randomUUID(), sourceGeneration: owner.record.ownerGeneration,
      from, to, codexEnvironment: owner.codexEnvironment,
    };
    await writePrivateJson(upgradeFile(dataDir), upgrade);
    const deadline = Date.now() + 20000;
    let requestId;
    do {
      const release = tryLease(privateDir(dataDir));
      if (release) {
        release();
        return finishUpgrade(dataDir, upgrade, null);
      }
      const result = await readRuntimeJson(exitResult(dataDir));
      const rejected = requestId && result?.ownerGeneration === upgrade.sourceGeneration
        && result?.requestId === requestId && result?.error === 'HANDOFF_BUSY';
      if (rejected && Date.now() >= deadline) {
        await remove(upgradeFile(dataDir));
        throw Error('HANDOFF_BUSY: a running turn has no confirmed handoff checkpoint yet');
      }
      if (!requestId || rejected) {
        requestId = randomUUID();
        await writePrivateJson(controlFile(dataDir), {
          action: 'handoff', id: upgrade.id, requestId, ownerGeneration: upgrade.sourceGeneration, token: owner.token,
        });
      }
      await pause(250);
    } while (Date.now() < deadline + 35000);
    throw Error('HANDOFF_RESULT_UNKNOWN: run service start to reconcile the saved upgrade');
  });
}

export function stopService(dataDir) {
  return manage(dataDir, () => stopOwner(dataDir));
}
async function stopOwner(dataDir) {
  if (await readRuntimeJson(upgradeFile(dataDir))) throw Error('UPGRADE_PENDING');
  const { record, token } = await connectOwner(dataDir);
  await remove(exitResult(dataDir));
  await writePrivateJson(controlFile(dataDir), {
    action: 'stop', ownerGeneration: record.ownerGeneration, token,
  });
  for (let i = 0; i < 300; i++) {
    try {
      const result = JSON.parse(await readFile(exitResult(dataDir), 'utf8'));
      if (result.ownerGeneration === record.ownerGeneration && result.error === 'TASK_ACTIVE') throw Error('TASK_ACTIVE: finish or cancel active task executions before exiting');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
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
    const registration = action === 'start' && extra.length === 4 && extra[0] === '--island-executable' && extra[2] === '--island-pid';
    const upgrade = action === 'upgrade' && extra.length === 2 && extra[0] === '--runtime-dir' && path.isAbsolute(extra[1]);
    if (!['start', 'stop', 'status', 'upgrade'].includes(action) || flag !== '--data-dir' || !dataDir || !path.isAbsolute(dataDir)
      || (action === 'upgrade' ? !upgrade : extra.length && !registration)) {
      throw Error('Usage: node desktop/service.mjs start|stop|status --data-dir <absolute-directory> | upgrade --data-dir <absolute-directory> --runtime-dir <absolute-directory>');
    }
    if (registration) await registerLauncher(process.env.WORKBENCH_ISLAND_LAUNCHER ?? path.join(os.homedir(), '.codex/task-workbench-light/launcher.json'), { executable: extra[1], pid: Number(extra[3]), dataDir });
    const result = upgrade ? await upgradeService(dataDir, extra[1]) : action === 'start' ? await startService(dataDir)
      : action === 'stop' ? await stopService(dataDir) : (await connectOwner(dataDir)).record;
    console.log(JSON.stringify(result));
    if (upgrade && result.rolledBack) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
