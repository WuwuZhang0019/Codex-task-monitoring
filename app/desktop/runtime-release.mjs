// 日期：2026-11-18。候选后台按发行清单校验并暂存，旧版进程可继续使用其原始文件。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFile, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { liveUpdateProtocol } from './runtime-protocol.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const sha256 = /^[a-f0-9]{64}$/;
const ownerEntry = 'app/desktop/owner.mjs';
const required = ['node.exe', ownerEntry, 'app/server/index.mjs', 'app/server/session-worker.mjs'];
async function fileDigest(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

export async function readRuntimeJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function bundledRelease() {
  const entry = fileURLToPath(new URL('./owner.mjs', import.meta.url));
  const manifest = await readFile(new URL('../../manifest.json', import.meta.url)).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  return { id: manifest ? digest(manifest) : 'source', node: process.execPath, entry };
}

export function checkedRelease(value) {
  if (!value || (value.id !== 'source' && !sha256.test(value.id))
    || !path.isAbsolute(value.node ?? '') || !path.isAbsolute(value.entry ?? '')) throw Error('INVALID_RUNTIME_RELEASE');
  return value;
}

export async function stageRelease(privateDirectory, sourceDirectory) {
  if (!path.isAbsolute(sourceDirectory)) throw Error('ABSOLUTE_RUNTIME_DIR_REQUIRED');
  const source = await realpath(sourceDirectory);
  const manifestFile = path.join(source, 'manifest.json');
  const bytes = await readFile(manifestFile);
  const manifest = JSON.parse(bytes);
  if (manifest.liveUpdateProtocol !== liveUpdateProtocol) throw Error('INCOMPATIBLE_RUNTIME_RELEASE');
  const resources = manifest.resources;
  if (!resources || required.some(file => !Object.hasOwn(resources, file))) throw Error('INVALID_RUNTIME_MANIFEST');
  const entries = Object.entries(resources);
  const names = new Set();
  for (const [name, hash] of entries) {
    const folded = name.toLowerCase();
    if (!name.split('/').every(part => part && !/[\\:<>"|?*\x00-\x1f]/.test(part) && !/[. ]$/.test(part)
      && !/^(con|aux|nul|prn|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
      || folded === 'manifest.json' || names.has(folded) || typeof hash !== 'string' || !sha256.test(hash)) throw Error('INVALID_RUNTIME_MANIFEST');
    names.add(folded);
  }
  const id = digest(bytes);
  const staged = path.join(privateDirectory, 'releases', id);
  const release = { id, node: path.join(staged, 'node.exe'), entry: path.join(staged, ownerEntry) };
  // Releases with a published manifest are immutable. A failed copy can be retried before publication.
  const published = await lstat(path.join(staged, 'manifest.json')).then(() => true, error => {
    if (error.code !== 'ENOENT') throw error;
    return false;
  });
  for (const [name, expected] of entries) {
    const input = path.join(source, name);
    const output = path.join(staged, name);
    if (!published) {
      if (path.relative(input, await realpath(input)) || !(await lstat(input)).isFile()) {
        throw Error('RUNTIME_RESOURCE_MISMATCH: ' + name);
      }
      await mkdir(path.dirname(output), { recursive: true });
      await copyFile(input, output);
    }
    if (await fileDigest(output) !== expected) throw Error('RUNTIME_RESOURCE_MISMATCH: ' + name);
  }
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const { stdout } = await promisify(execFile)(release.node, [release.entry, '--probe-update'], {
    windowsHide: true, env, timeout: 10000,
  });
  if (JSON.parse(stdout).liveUpdateProtocol !== liveUpdateProtocol) throw Error('INCOMPATIBLE_RUNTIME_RELEASE');
  if (!published) {
    const temporary = path.join(staged, 'manifest.pending');
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, path.join(staged, 'manifest.json'));
  }
  return release;
}
