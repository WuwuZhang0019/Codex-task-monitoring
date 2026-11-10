import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, open, readFile, rename, unlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from './receipts.mjs';
import { validateDatabase, HttpError } from './validation.mjs';
import { validateRelationships } from './relationships.mjs';

async function readJSON(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function durableWrite(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
  } finally {
    await handle?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

function validate(state) {
  if (state?.version !== 1 || !state.models || !state.drafts || !state.requests || !Array.isArray(state.audit)) throw Error('Invalid aggregate');
  validateDatabase(state.projects);
  for (const [id, entry] of Object.entries(state.models)) {
    if (!state.projects.projects.some(p => p.id === id) || !Number.isSafeInteger(entry.revision) || entry.revision < 1) throw Error('Invalid aggregate model');
    validateRelationships(entry.model);
  }
  return state;
}

// The caller holds the OS data-root lease for this instance's entire lifetime.
export async function createPersistence(directory, { fault = async () => {} } = {}) {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'aggregate.json');
  const preparedFile = path.join(directory, 'transaction.prepared.json');
  const committedFile = path.join(directory, 'transaction.committed.json');
  const committed = await readJSON(committedFile);
  if (committed) {
    const prepared = await readJSON(preparedFile);
    if (!prepared || prepared.id !== committed.id || digest(prepared.state) !== committed.hash) throw Error('RECOVERY_REQUIRED: transaction content mismatch');
    await durableWrite(file, validate(prepared.state));
    await unlink(committedFile);
    await unlink(preparedFile);
  } else {
    await unlink(preparedFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  let state = await readJSON(file);
  if (!state) {
    const snapshotFile = path.join(directory, 'aggregate-migration-source.json');
    if (await readJSON(snapshotFile)) throw Error('RECOVERY_REQUIRED: aggregate missing after migration');
    const projects = await readJSON(path.join(directory, 'projects.json'));
    if (!projects && await readJSON(path.join(directory, 'projects.json.bak'))) throw Error('Legacy primary missing, restore backup');
    state = { version: 1, projects: projects ?? { version: 1, projects: [] }, models: {}, drafts: {}, requests: {}, grants: {}, audit: [], events: [] };
    const modelDirectory = path.join(directory, 'models');
    const names = await readdir(modelDirectory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const project of state.projects.projects) {
      const model = await readJSON(path.join(modelDirectory, `${project.id}.json`));
      if (model) state.models[project.id] = model;
      else if (names.includes(`${project.id}.json.bak`)) throw Error('Legacy model primary missing, restore backup');
    }
    validate(state);
    // Keep the exact legacy aggregate in an immutable, durable migration record.
    await durableWrite(snapshotFile, state);
    try { await durableWrite(file, state); }
    catch (error) { await unlink(snapshotFile); throw error; }
  }
  validate(state);
  const context = new AsyncLocalStorage();
  let queue = Promise.resolve();
  let recoveryRequired = false;
  function check() { if (recoveryRequired) throw new HttpError(503, 'RECOVERY_REQUIRED: 请重开以恢复已提交事务'); }
  function read(key) { check(); return structuredClone((context.getStore()?.state ?? state)[key]); }
  function write(key, value) {
    check();
    const transaction = context.getStore();
    if (!transaction) throw Error('Write outside transaction');
    transaction.state[key] = structuredClone(value);
    transaction.changed = true;
  }
  function run(operation) {
    if (context.getStore()) return operation();
    const promise = queue.then(async () => {
      check();
      const transaction = { state: structuredClone(state), changed: false };
      return context.run(transaction, async () => {
        const result = await operation();
        if (!transaction.changed) return result;
        validate(transaction.state);
        const prepared = { id: randomUUID(), state: transaction.state };
        const marker = { id: prepared.id, hash: digest(prepared.state) };
        let marked = false;
        try {
          await fault('beforePrepare');
          await durableWrite(preparedFile, prepared);
          await fault('prepared');
          await durableWrite(`${file}.bak`, state);
          await durableWrite(committedFile, marker);
          marked = true;
          await fault('committed');
          await durableWrite(file, prepared.state);
          await fault('installed');
          // Publish to all readers only after the durable snapshot is installed.
          state = prepared.state;
          await unlink(committedFile);
          await unlink(preparedFile);
          return result;
        } catch (error) {
          if (marked) recoveryRequired = true;
          else await unlink(preparedFile).catch(() => {});
          throw error;
        }
      });
    });
    queue = promise.catch(() => {});
    return promise;
  }
  return { read, write, run };
}
