import { readFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';

// This discovery helper never launches an owner. Tokens arrive via a controlled caller.
export async function discoverOwner(dataDir) {
  try { await readFile(path.join(dataDir, 'stopped.json')); throw Error('STOPPED'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const record = JSON.parse(await readFile(path.join(dataDir, 'owner.json'), 'utf8'));
  if (record.version !== 1 || !/^http:\/\/127\.0\.0\.1:\d+$/.test(record.endpoint) || !record.ownerGeneration) throw Error('INVALID_OWNER');
  return record;
}

// Date: 2026-11-12. Only controlled native/service callers use the management session.
export async function connectOwner(dataDir) {
  const record = await discoverOwner(dataDir);
  const session = JSON.parse(await readFile(path.join(dataDir, 'runtime-private/owner-session.json'), 'utf8'));
  if (session.version !== 1 || session.ownerGeneration !== record.ownerGeneration
    || typeof session.token !== 'string' || !/^[a-f0-9]{64}$/.test(session.token)) throw Error('INVALID_OWNER_SESSION');
  // Built-in HTTP has no environment proxy or redirect handling.
  await new Promise((resolve, reject) => {
    const request = http.get(`${record.endpoint}/api/health`, {
      headers: { Authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(2000),
    }, response => {
      response.resume();
      if (response.statusCode === 200) resolve();
      else reject(Error('OWNER_UNAVAILABLE'));
    });
    request.once('error', reject);
  });
  return { record, token: session.token };
}
