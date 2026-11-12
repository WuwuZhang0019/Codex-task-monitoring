// 日期：2026-11-12。只读核验源码、独立安装、插件发布指纹与实际导出行为。
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [source, standalone, plugin] = process.argv.slice(2);
if (![source, standalone, plugin].every(value => value && path.isAbsolute(value))) throw Error('Pass absolute source skill, standalone skill, and plugin directories');
async function inventory(directory) {
  const files = {};
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(file);
      else files[path.relative(directory, file).replaceAll('\\', '/')] = createHash('sha256').update(await readFile(file)).digest('hex');
    }
  }
  await visit(directory); return files;
}
function compare(a, b) {
  const differences = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(key => a[key] !== b[key]);
  return { equal: differences.length === 0, differences };
}
async function behavior(directory) {
  try {
    const module = await import(pathToFileURL(path.join(directory, 'scripts/coordination.mjs')).href);
    const state = module.createCoordination({ id: 'installation-smoke', coordinator: { threadId: 'fixture', hostId: 'local' },
      authorization: { mode: 'generate', permissions: [] } });
    const before = JSON.stringify(state);
    const batch = module.planBatch(state, { id: 'batch', tasks: [{ id: 'task', lineId: 'line', stepIds: ['step'], spec: {} }] }, { projects: [], plans: [] });
    const generationGate = JSON.stringify(state) === before && batch.tasks.length === 0 && state.operations.length === 0;
    state.authorization = { mode: 'execute', permissions: ['createChat'], lineIds: ['line'], stepIds: ['step'],
      source: { threadId: 'fixture', locator: 'fixture-turn', quote: '仅隔离行为验证' } };
    let worktreeGate = false;
    try { module.createRequest(state, { lineId: 'line', stepIds: ['step'] }, { hostProjectId: 'host-project', hostId: 'local', worktreePath: 'G:\\fixture\\worktree' },
      [{ projectId: 'host-project', hostId: 'local', path: 'G:\\fixture\\source' }]); }
    catch (error) { worktreeGate = error.message === 'HOST_EXISTING_WORKTREE_UNSUPPORTED'; }
    return { available: true, generationGate, worktreeGate, recoveryReadable: module.recoveryReport(state).unfinished.length === 0,
      nativeDispatch: 'notRun' };
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return { available: false, reason: 'COORDINATION_MODULE_NOT_INSTALLED', nativeDispatch: 'notRun' };
    throw error;
  }
}
const pluginSkill = path.join(plugin, 'skills/workbench-handoff');
const roots = { source, standalone, pluginSkill };
const files = Object.fromEntries(await Promise.all(Object.entries(roots).map(async ([key, value]) => [key, await inventory(value)])));
const manifest = JSON.parse(await readFile(path.join(plugin, 'release-manifest.json'), 'utf8'));
const actual = await inventory(plugin);
const mismatches = Object.entries(manifest.fingerprints).filter(([key, sha]) => actual[key] !== sha).map(([key]) => key);
const unlisted = Object.keys(actual).filter(key => key !== 'release-manifest.json' && !manifest.fingerprints[key]);
console.log(JSON.stringify({ date: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date()), roots,
  pluginVersion: manifest.version, sourceCommit: manifest.sourceCommit, releaseReady: manifest.releaseReady,
  sourceVsStandalone: compare(files.source, files.standalone), sourceVsPlugin: compare(files.source, files.pluginSkill),
  standaloneVsPlugin: compare(files.standalone, files.pluginSkill),
  releaseIntegrity: { valid: mismatches.length === 0 && unlisted.length === 0, mismatches, unlisted }, files,
  behavior: Object.fromEntries(await Promise.all(Object.entries(roots).map(async ([key, value]) => [key, await behavior(value)]))) }, null, 2));
