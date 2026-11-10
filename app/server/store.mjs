import { mkdir, readFile, open, rename, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError, validateDatabase, projectInput } from './validation.mjs';
import { existsSync } from 'node:fs';

async function atomicWrite(file, content) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close(); handle = undefined;
    await rename(temporary, file);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

// One store/queue per running server; the data directory is owned by that process.
export async function createStore(directory, persistence) {
  await mkdir(directory, { recursive: true });
  if (!persistence && (existsSync(path.join(directory, 'aggregate.json')) || existsSync(path.join(directory, 'transaction.committed.json')))) throw Error('AGGREGATE_REQUIRED: 请使用当前领域所有者，禁止回写旧文件');
  const file = path.join(directory, 'projects.json');
  let data;
  try {
    data = persistence ? persistence.read('projects') : validateDatabase(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`项目数据损坏或无法读取 (${file})，未清空数据；请检查 projects.json 或手动恢复 projects.json.bak。${error.message}`, { cause: error });
    // A missing primary with an existing backup is not a new installation.
    try {
      await stat(`${file}.bak`);
      throw new Error(`主数据缺失但发现备份 (${file}.bak)，请手动恢复；未创建空数据`);
    } catch (backupError) {
      if (backupError.code !== 'ENOENT') throw backupError;
    }
    data = { version: 1, projects: [] };
    await atomicWrite(file, JSON.stringify(data, null, 2) + '\n');
  }
  let queue = Promise.resolve();
  const current = () => persistence ? persistence.read('projects') : data;
  function transact(change) {
    if (persistence) return persistence.run(() => {
      const next = current();
      const result = change(next);
      persistence.write('projects', next);
      return structuredClone(result);
    });
    const operation = queue.then(async () => {
      const next = structuredClone(data);
      const result = change(next);
      // Keep the last committed version, not a partially written new version.
      await atomicWrite(`${file}.bak`, JSON.stringify(data, null, 2) + '\n');
      await atomicWrite(file, JSON.stringify(next, null, 2) + '\n');
      data = next;
      return structuredClone(result);
    });
    queue = operation.catch(() => {});
    return operation;
  }
  return {
    list: () => structuredClone(current().projects),
    get(id) {
      const project = current().projects.find(item => item.id === id);
      if (!project) throw new HttpError(404, '项目不存在');
      return structuredClone(project);
    },
    create(body, assignedId) {
      const input = projectInput(body);
      return transact(next => {
        const now = new Date().toISOString();
        const project = { id: assignedId ?? randomUUID(), ...input, revision: 1, createdAt: now, updatedAt: now };
        next.projects.push(project);
        return project;
      });
    },
    update(id, body, publication = false) {
      const input = projectInput(body, true);
      const revision = body.revision;
      return transact(next => {
        const index = next.projects.findIndex(item => item.id === id);
        if (index < 0) throw new HttpError(404, '项目不存在');
        const old = next.projects[index];
        if (!publication && persistence?.read('models')[id]?.model.schemaVersion) {
          const shape = p => ({name:p.name,goal:p.goal,source:p.source,steps:p.steps.map(({status,summary,nextAction,blocker,evidence,...head})=>head)});
          if (JSON.stringify(shape(old)) !== JSON.stringify(shape(input))) throw new HttpError(400, '正式路线变更必须经过草稿差异确认发布');
        }
        if (old.revision !== revision) throw new HttpError(409, 'revision 冲突，请重新加载项目后再保存');
        const project = { ...old, ...input, revision: old.revision + 1, updatedAt: new Date().toISOString() };
        next.projects[index] = project;
        return project;
      });
    },
  };
}
