// 日期：2026-11-12。仅隔离项目的原生宿主联验；令牌只在独立测试目录中传递。
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createServer } from '../../server/index.mjs';
import { prepareLightPlan } from '../../server/light-import.mjs';
import { inspectWorktree } from '../../../plugins/task-workbench/skills/workbench-handoff/scripts/context-ledger.mjs';
import { HttpError } from '../../server/validation.mjs';

const [command, suppliedRoot, line] = process.argv.slice(2);
const allowed = fileURLToPath(new URL('../../test-results/', import.meta.url));
const root = path.resolve(suppliedRoot ?? '');
if (!root.startsWith(path.resolve(allowed) + path.sep) || path.basename(root) !== 'coordination-native-20261112') throw Error('ISOLATED_NATIVE_ROOT_REQUIRED');
const json = async name => JSON.parse(await readFile(path.join(root, name), 'utf8'));
const save = (name, value) => writeFile(path.join(root, name), JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
const accepted = value => { if (value.status !== 'accepted') throw Error(JSON.stringify(value.error)); return value.result; };
async function call(config, name, args) {
  const response = await fetch(config.endpoint + '/api/light-mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, arguments: args }), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw Error('ISOLATED_HTTP_' + response.status);
  return accepted((await response.json()).structuredContent);
}
if (command === 'serve') {
  await mkdir(root, { recursive: true });
  const server = await createServer({ dataDir: path.join(root, 'data'), env: {}, lightAccessEnabled: true,
    authorize(_req, pathname) { if (pathname !== '/api/light-mcp') throw new HttpError(403, 'ISOLATED_MCP_ONLY'); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const endpoint = 'http://127.0.0.1:' + server.address().port;
  const actor = await server.workbench.lightAccess.connect({ acknowledged: true, appId: 'codex' });
  const projects = await json('host-projects.json');
  const context = { sessionGroup: 'native-isolated', threadId: process.env.CODEX_THREAD_ID ?? 'isolated-coordinator', hostId: 'local',
    folderId: projects.find(item => item.path.endsWith('alpha'))?.projectId ?? null, worktreeOrdinal: 1, worktreePath: path.join(root, 'alpha'),
    branch: 'codex/coordination-fixture', head: null, trust: 'declared' };
  const sourceText = '# 原生协调隔离方案\n日期：2026-11-12\n## 实施路线与出口\n| 阶段 | 前置 | 范围 | 出口 |\n| A Alpha | 无 | 只读核对与固定回执 | Alpha 标记与目录验证 |\n| B Beta | A | 只读核对与固定回执 | Beta 标记与目录验证 |\n';
  const sourceFile = path.join(root, 'plan.md'); await writeFile(sourceFile, sourceText, 'utf8');
  const snapshot = prepareLightPlan({ text: sourceText, sourcePath: sourceFile, version: 'native-isolated-v1', projectKey: 'native-isolated/project', planKey: 'native-isolated/plan', name: '原生协调隔离验收', date: '2026-11-12', context });
  const { trust, ...source } = snapshot.plans[0].source;
  const existing = server.workbench.persistence.read('light')?.snapshot.projects.find(item => item.key === 'native-isolated/project');
  let projectId, planId;
  if (existing) { projectId = existing.id; planId = server.workbench.light.read(actor.principal, projectId).plans[0].id; }
  else {
    const input = { schemaVersion: 'light-1.0', expectedRevision: 0, eventId: 'native-isolated/register', source, occurredAt: '2026-11-12T12:00:00+08:00', snapshot };
    const confirmation = await server.workbench.lightPublication.confirm(actor.principal, 'register', input);
    const result = await server.workbench.lightPublication.publish(actor.principal, 'register', { ...input, confirmationGrant: confirmation.confirmationGrant });
    projectId = result.projectId; planId = result.planIds[0];
  }
  await save('coordinator-connection.json', { endpoint, token: actor.token });
  for (const name of ['alpha', 'beta']) {
    const grant = await server.workbench.lightAccess.connect({ acknowledged: true, appId: 'codex' });
    await save(name + '-connection.json', { endpoint, token: grant.token });
  }
  await save('native-info.json', { date: '2026-11-12', endpoint, projectId, planId, source, projects });
  console.log(JSON.stringify({ ready: true, root, endpoint, projectId, planId }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.closeAllConnections(); server.close(); });
} else if (command === 'snapshot') {
  const info = await json('native-info.json'); console.log(JSON.stringify(await call(await json('coordinator-connection.json'), 'workbench_get_project', { projectId: info.projectId }), null, 2));
} else if (command === 'actor') {
  if (!['alpha', 'beta'].includes(line) || !process.env.CODEX_THREAD_ID) throw Error('NATIVE_ACTOR_IDENTITY_REQUIRED');
  const directory = await realpath(path.join(root, line));
  if ((await realpath(process.cwd())).toLowerCase() !== directory.toLowerCase()) throw Error('NATIVE_ACTOR_CWD_MISMATCH');
  const actual = await inspectWorktree(directory, 'codex/coordination-fixture');
  const info = await json('native-info.json'), config = await json(line + '-connection.json');
  const code = line === 'alpha' ? 'A' : 'B', threadId = process.env.CODEX_THREAD_ID;
  const read = () => call(config, 'workbench_get_project', { projectId: info.projectId });
  let snapshot = await read(), step = snapshot.steps.find(item => item.code === code);
  const context = { sessionGroup: 'native-isolated', threadId, hostId: 'local', folderId: info.projects.find(item => item.path.toLowerCase() === directory.toLowerCase()).projectId,
    worktreeOrdinal: line === 'alpha' ? 1 : 2, ...actual, trust: 'declared' };
  delete context.repositoryRoot; delete context.gitCommonDir;
  const occurredAt = '2026-11-12T12:00:00+08:00';
  const base = async action => { snapshot = await read(); return { schemaVersion: 'light-1.0', projectId: info.projectId, planId: info.planId,
    source: info.source, expectedRevision: snapshot.projects[0].revision, eventId: `native-isolated/${line}/${threadId}/${action}`, occurredAt, reason: '原生隔离协调验收' }; };
  const write = async (name, args, operation) => {
    const query = await call(config, 'workbench_query_event', { projectId: info.projectId, operation, eventId: args.eventId });
    return query.state === 'committed' ? query.result : call(config, name, args);
  };
  let binding = snapshot.bindings.find(item => item.state === 'confirmed' && item.stepKeys.includes(step.key));
  if (binding && binding.context.threadId !== threadId) throw Error('NATIVE_ACTOR_TAKEOVER_REQUIRED');
  if (!binding) {
    await write('workbench_bind_context', { ...await base('bind'), action: 'propose', stepIds: [step.id], context,
      bindingId: null, expectedBindingRevision: null, confirmationGrant: null }, 'bind');
    snapshot = await read(); binding = snapshot.bindings.find(item => item.state === 'confirmed' && item.stepKeys.includes(step.key));
  }
  if (!binding) throw Error('NATIVE_BINDING_NOT_CONFIRMED');
  let execution = snapshot.executions.find(item => item.stepKeys.includes(step.key));
  if (!execution) {
    const reservation = await write('workbench_reserve_execution', await base('reserve'), 'reserveExecution');
    await write('workbench_update_step_status', { ...await base('start'), stepId: step.id, executionId: reservation.executionId,
      bindingId: binding.id, bindingRevision: binding.bindingRevision, targetStatus: 'running', evidence: [], checks: [], blocker: null, reopen: null, successorImpact: null }, 'update');
    snapshot = await read(); execution = snapshot.executions.find(item => item.stepKeys.includes(step.key));
  }
  const text = await readFile(path.join(directory, 'README.md'), 'utf8'), marker = `COORDINATION_${line.toUpperCase()}_20261112`;
  if (!text.includes(marker)) throw Error('NATIVE_MARKER_MISMATCH');
  const sha256 = createHash('sha256').update(text).digest('hex'), evidenceId = 'native-' + line + '-readme';
  const evidence = [{ evidenceId, location: path.join(directory, 'README.md'), deliveryVersion: actual.head, method: '只读真实 cwd/Git/固定标记与 SHA256', result: 'passed' }];
  const checks = step.conditions.map(item => ({ ...item, result: 'passed', evidenceIds: [evidenceId] }));
  if (!execution.endedAt) await write('workbench_update_step_status', { ...await base('finish'), stepId: step.id, executionId: execution.id,
    bindingId: binding.id, bindingRevision: binding.bindingRevision, targetStatus: 'completed', evidence, checks, blocker: null, reopen: null, successorImpact: null }, 'update');
  console.log(JSON.stringify({ date: '2026-11-12', marker, threadId, hostId: 'local', hostProjectId: context.folderId, projectId: info.projectId, planId: info.planId,
    stepIds: [step.id], executionIds: [execution.id], bindingId: binding.id, bindingRevision: binding.bindingRevision, ...actual, sha256, handoff: 'E', evidence }, null, 2));
} else throw Error('USAGE: coordination-native.mjs <serve|snapshot|actor> <isolated-root> [alpha|beta]');
