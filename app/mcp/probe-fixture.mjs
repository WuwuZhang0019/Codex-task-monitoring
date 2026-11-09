import path from 'node:path';
import { createStore } from '../server/store.mjs';
import { createModelStore } from '../server/model-store.mjs';

export async function createProbeFixture(dataDir) {
  const projects = await createStore(dataDir);
  if (projects.list().length) throw new Error('Probe requires an empty isolated data directory');
  const project = await projects.create({ name: 'U01 隔离读取样例', goal: '验证 MCP 返回领域服务中的真实持久化数据',
    source: '2026-11-09 U01 fixed fixture', steps: [{ id: 'U01', title: '现场与契约验证', purpose: '最小读取探测',
      line: '统一实施路线', sourceExcerpt: '2026-11-09 U01 fixed fixture',
      acceptance: ['真实协议往返'], dependsOn: [], status: 'todo', summary: '', nextAction: '', blocker: '', evidence: '' }] });
  const models = await createModelStore(path.join(dataDir, 'models'), projects);
  const value = await models.get(project.id);
  await models.update(project.id, value);
  return project.id;
}
