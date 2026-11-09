import { readFile } from 'node:fs/promises';
import path from 'node:path';

// This discovery helper never launches an owner. Tokens arrive via a controlled caller.
export async function discoverOwner(dataDir) {
  try { await readFile(path.join(dataDir, 'stopped.json')); throw Error('STOPPED'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const record = JSON.parse(await readFile(path.join(dataDir, 'owner.json'), 'utf8'));
  if (record.version !== 1 || !/^http:\/\/127\.0\.0\.1:\d+$/.test(record.endpoint) || !record.ownerGeneration) throw Error('INVALID_OWNER');
  return record;
}
