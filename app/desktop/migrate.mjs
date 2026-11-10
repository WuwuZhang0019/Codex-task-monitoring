import path from 'node:path';
import { mkdir, readdir, readFile, writeFile, cp, rename, rm, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { acquireDataLease } from '../server/data-lease.mjs';
import { createStore } from '../server/store.mjs';
import { createModelStore } from '../server/model-store.mjs';
import { createPersistence } from '../server/persistence.mjs';

const excluded = new Set(['.owner-lock.sqlite', '.owner-lock.sqlite-journal', 'owner.json', 'owner.json.tmp', 'stopped.json', '.migration-pending.json']);
async function manifest(root, relative = '') {
  const result = {};
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    if (!relative && excluded.has(entry.name)) continue;
    if (entry.isSymbolicLink()) throw Error('迁移拒绝符号链接');
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(result, await manifest(root, name));
    else result[name] = createHash('sha256').update(await readFile(path.join(root, name))).digest('hex');
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}
async function validate(root) {
  const names = await readdir(root);
  if (names.includes('transaction.committed.json')) throw Error('请先由原服务恢复已提交事务，再执行目录迁移');
  const persistence = names.includes('aggregate.json') ? await createPersistence(root) : undefined;
  const projects = await createStore(root, persistence);
  const models = await createModelStore(path.join(root, 'models'), projects, persistence);
  for (const project of projects.list()) await models.get(project.id);
}
export async function migrate(source, target, { failAfterCopy = false } = {}) {
  source = await realpath(source);
  const primary = (await readdir(source)).includes('aggregate.json') ? 'aggregate.json' : 'projects.json';
  await readFile(path.join(source, primary));
  await mkdir(target, { recursive: true });
  target = await realpath(target);
  const relative = path.relative(source, target);
  const reverse = path.relative(target, source);
  if (!relative || !relative.startsWith('..') || !reverse.startsWith('..')) throw Error('迁移目录必须互相独立');
  const releaseSource = acquireDataLease(source);
  let releaseTarget;
  const stage = `${target}.migration-${randomUUID()}`;
  const backup = `${target}.backup-${randomUUID()}`;
  try {
    releaseTarget = acquireDataLease(target);
    const targetFiles = await manifest(target);
    if (Object.keys(targetFiles).length) throw Error('目标目录已有数据，保留原内容并停止迁移');
    await readFile(path.join(source, primary)); // Never create an empty legacy source.
    const before = await manifest(source);
    await mkdir(backup, { recursive: true });
    await mkdir(stage, { recursive: true });
    for (const name of Object.keys(before)) {
      for (const destination of [backup, stage]) {
        await mkdir(path.dirname(path.join(destination, name)), { recursive: true });
        await cp(path.join(source, name), path.join(destination, name));
      }
    }
    if (JSON.stringify(before) !== JSON.stringify(await manifest(source)) || JSON.stringify(before) !== JSON.stringify(await manifest(stage))) throw Error('旧数据仍在变化或复制不完整，请先停止旧写入者');
    await validate(stage);
    await writeFile(`${backup}.manifest.json`, JSON.stringify({ date: new Date().toISOString(), source, files: before }, null, 2));
    await writeFile(path.join(target, '.migration-pending.json'), JSON.stringify({ stage, backup, files: Object.keys(before) }));
    if (failAfterCopy) throw Error('Injected migration interruption');
    // Publish the authoritative primary last. The marker denies startup throughout.
    const names = Object.keys(before).filter(n => n !== primary).concat(primary);
    for (const name of names) {
      await mkdir(path.dirname(path.join(target, name)), { recursive: true });
      await rename(path.join(stage, name), path.join(target, name));
    }
    await validate(target);
    if (JSON.stringify(before) !== JSON.stringify(await manifest(target))) throw Error('迁移校验失败');
    await rm(path.join(target, '.migration-pending.json'));
    return { backup, files: before, sourceUnchanged: JSON.stringify(before) === JSON.stringify(await manifest(source)) };
  } finally {
    releaseTarget?.(); releaseSource();
    // Staging and backup remain available on failure for explicit recovery.
  }
}

export async function recoverMigration(target) {
  const release = acquireDataLease(target);
  try {
    const marker = JSON.parse(await readFile(path.join(target, '.migration-pending.json'), 'utf8'));
    // The target was verified empty before migration. Roll back only named copied files.
    for (const name of marker.files) {
      const resolved = path.resolve(target, name);
      if (!resolved.startsWith(`${path.resolve(target)}${path.sep}`)) throw Error('无效恢复清单');
      await rm(resolved, { force: true });
    }
    await rm(path.join(target, '.migration-pending.json'));
    return { restored: 'emptyTarget', backup: marker.backup };
  } finally { release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [source, target] = process.argv.slice(2);
    const result = source === '--recover' ? await recoverMigration(target) : await migrate(source, target);
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
