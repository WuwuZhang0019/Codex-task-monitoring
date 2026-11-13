// 日期：2026-11-12。Agent 驱动的协调日志，复用 context-ledger 与服务的绑定/开始门禁。
import { createHash } from 'node:crypto';
import { readFile, open, rename, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { inspectWorktree, runHostOperation } from './context-ledger.mjs';

const clone = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const check = (condition, code) => { if (!condition) throw Error(code); };
const nonempty = value => typeof value === 'string' && !!value.trim();
export const pathKey = value => {
  check(nonempty(value), 'PATH_REQUIRED');
  return /^[a-z]:[\\/]|^\\\\/i.test(value) ? path.win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase()
    : path.posix.normalize(value).replace(/\/$/, '') || '/';
};
const samePath = (a, b) => pathKey(a) === pathKey(b);
const permissions = ['register', 'createChat', 'dispatch', 'collect', 'reportBack', 'continue', 'createWorktree', 'push', 'publish', 'provider'];

export function createCoordination({ id, date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date()), projectId = null, planId = null, coordinator, authorization }) {
  const state = { version: 1, date, id, projectId, planId, coordinator: clone(coordinator),
    coordinatorHistory: [], authorization: clone(authorization), mappings: [], mappingHistory: [], operations: [], batches: [], observations: [], unconfirmedEvents: [] };
  return validateCoordination(state);
}
export function validateCoordination(state, previous) {
  check(state?.version === 1 && nonempty(state.id) && /^\d{4}-\d{2}-\d{2}$/.test(state.date), 'COORDINATION_ID_REQUIRED');
  check(nonempty(state.coordinator?.threadId) && nonempty(state.coordinator?.hostId), 'COORDINATOR_REQUIRED');
  const auth = state.authorization;
  check(['inspect', 'generate', 'execute'].includes(auth?.mode) && Array.isArray(auth.permissions)
    && auth.permissions.every(item => permissions.includes(item)), 'AUTHORIZATION_MODE_REQUIRED');
  check(auth.mode !== 'execute' || nonempty(auth.source?.threadId) && nonempty(auth.source?.locator) && nonempty(auth.source?.quote)
    && Array.isArray(auth.lineIds) && Array.isArray(auth.stepIds), 'HUMAN_AUTHORIZATION_SOURCE_REQUIRED');
  for (const key of ['mappings', 'mappingHistory', 'operations', 'batches', 'observations', 'unconfirmedEvents']) check(Array.isArray(state[key]), 'INVALID_COORDINATION_ARRAY');
  for (const { key, mapping } of state.mappings) check(nonempty(key) && nonempty(mapping?.lineId) && nonempty(mapping.hostId)
    && nonempty(mapping.hostProjectId) && nonempty(mapping.worktreePath) && nonempty(mapping.repositoryRoot)
    && nonempty(mapping.gitCommonDir) && nonempty(mapping.branch) && Array.isArray(mapping.stepIds) && mapping.stepIds.length, 'INVALID_LINE_MAPPING');
  check(new Set(state.mappings.map(item => item.mapping.lineId)).size === state.mappings.length, 'DUPLICATE_LINE_ID');
  for (const key of ['operations', 'batches']) check(new Set(state[key].map(item => item.operationId ?? item.id)).size === state[key].length, 'DUPLICATE_COORDINATION_ID');
  for (const operation of state.operations) check(nonempty(operation.operationId) && operation.contentHash === fingerprint(operation.intent)
    && ['pending', 'succeeded', 'failed', 'unsupported'].includes(operation.status), 'INVALID_HOST_OPERATION');
  for (const batch of state.batches) {
    check(nonempty(batch.id) && nonempty(batch.intentHash) && Array.isArray(batch.tasks) && Array.isArray(batch.deferred), 'INVALID_COORDINATION_BATCH');
    for (const task of batch.tasks) check(nonempty(task.id) && nonempty(task.lineId) && task.stepIds?.length
      && ['prepared', 'created', 'contextVerified', 'delivered', 'awaitingStart', 'started', 'blocked', 'receiptReview', 'verified', 'cancelled'].includes(task.state), 'INVALID_COORDINATION_TASK');
  }
  const taskIds = state.batches.flatMap(batch => batch.tasks.map(task => task.id));
  check(new Set(taskIds).size === taskIds.length, 'DUPLICATE_COORDINATION_TASK');
  if (previous) {
    check(state.id === previous.id && state.projectId === previous.projectId && state.planId === previous.planId, 'COORDINATION_SCOPE_CHANGED');
    for (const operation of previous.operations) check(state.operations.some(item => item.operationId === operation.operationId
      && item.contentHash === operation.contentHash && (operation.status !== 'succeeded' || fingerprint(item) === fingerprint(operation))), 'OPERATION_HISTORY_REQUIRED');
    for (const key of ['observations', 'mappingHistory']) check(previous[key].every((item, index) => fingerprint(item) === fingerprint(state[key][index])), 'COORDINATION_HISTORY_REQUIRED');
    check(previous.batches.every(item => state.batches.some(next => next.id === item.id && next.intentHash === item.intentHash)), 'BATCH_HISTORY_REQUIRED');
    if (fingerprint(state.coordinator) !== fingerprint(previous.coordinator)) check(state.coordinatorHistory?.some(item => fingerprint(item.previous) === fingerprint(previous.coordinator)
      && nonempty(item.evidence)), 'COORDINATOR_TAKEOVER_EVIDENCE_REQUIRED');
  }
  check(Buffer.byteLength(JSON.stringify(state)) <= 512 * 1024, 'COORDINATION_CHECKPOINT_TOO_LARGE');
  return state;
}
export function adoptCoordination(state, { coordinator, evidence }) {
  check(nonempty(coordinator?.threadId) && nonempty(coordinator?.hostId) && nonempty(evidence), 'COORDINATOR_TAKEOVER_EVIDENCE_REQUIRED');
  state.coordinatorHistory ??= [];
  state.coordinatorHistory.push({ previous: clone(state.coordinator), evidence, at: new Date().toISOString() });
  state.coordinator = clone(coordinator);
  // 原人类授权仍可用；主动向一个新聊天发回消息不随接手自动扩展。
  state.authorization.permissions = state.authorization.permissions.filter(item => item !== 'reportBack');
  return recoveryReport(state);
}
function authorized(state, permission, task) {
  const a = state.authorization;
  return a.mode === 'execute' && !a.revokedAt && a.permissions.includes(permission)
    && (!task || a.lineIds.includes(task.lineId) && task.stepIds.every(id => a.stepIds.includes(id)));
}

// 显示名和来源目录不作为身份；先用固定项目 ID，再独立核对实际 Git 目录。
export async function mapLine(state, mapping, projects, inspect = inspectWorktree) {
  const project = projects.find(item => item.projectId === mapping.hostProjectId && item.hostId === mapping.hostId);
  check(project, 'HOST_PROJECT_NOT_FOUND');
  check(mapping.hostId === 'local' || inspect !== inspectWorktree, 'REMOTE_INSPECTION_ADAPTER_REQUIRED');
  const actual = await inspect(mapping.worktreePath, mapping.branch);
  check(actual.repositoryRoot && actual.gitCommonDir && actual.head, 'REPOSITORY_EVIDENCE_REQUIRED');
  check(!mapping.repositoryRoot || samePath(mapping.repositoryRoot, actual.repositoryRoot), 'REPOSITORY_ROOT_MISMATCH');
  const value = { ...clone(mapping), ...actual, projectSourcePath: project.path, projectLabel: project.label,
    planKey: mapping.planKey ?? state.planId ?? state.id, stepKeys: mapping.stepKeys ?? mapping.stepIds,
    threadId: mapping.threadId ?? null };
  check(nonempty(mapping.lineId) && mapping.stepIds?.length, 'LINE_SCOPE_REQUIRED');
  const old = state.mappings.find(item => item.mapping.lineId === mapping.lineId);
  if (old && fingerprint(old.mapping) !== fingerprint(value)) state.mappingHistory.push(clone(old));
  if (old) state.mappings.splice(state.mappings.indexOf(old), 1);
  state.mappings.push({ key: fingerprint([state.id, mapping.lineId]), mapping: value });
  return clone(value);
}
const mappingFor = (state, lineId) => state.mappings.find(item => item.mapping.lineId === lineId)?.mapping;

// 日期：2026-11-13。创建聊天前准备宿主项目；缺少 API 时检查被允许的界面路径。
// 返回语义操作而非杜撰工具参数；Agent 仍须读取实际工具 schema 或电脑技能。
export async function planHostProjects(state, { targets, projects, capabilities = {} }, inspect = inspectWorktree) {
  check(Array.isArray(targets) && Array.isArray(projects), 'HOST_PROJECT_INPUT_REQUIRED');
  const results = [];
  for (const target of targets) {
    check(nonempty(target.lineId) && nonempty(target.hostId) && nonempty(target.worktreePath)
      && (path.win32.isAbsolute(target.worktreePath) || path.posix.isAbsolute(target.worktreePath))
      && Array.isArray(target.stepIds) && target.stepIds.length, 'HOST_PROJECT_TARGET_REQUIRED');
    const item = { ...clone(target), status: 'blocked', hostProjectId: null, action: null };
    results.push(item);
    if (target.hostId !== 'local' && inspect === inspectWorktree) { item.reason = 'REMOTE_INSPECTION_ADAPTER_REQUIRED'; continue; }
    let actual;
    try { actual = await inspect(target.worktreePath, target.branch); }
    catch (error) { item.reason = 'WORKSPACE_INSPECTION_FAILED'; item.detail = error.message; continue; }
    check(actual.repositoryRoot && actual.gitCommonDir && actual.head, 'REPOSITORY_EVIDENCE_REQUIRED');
    item.worktreePath = actual.worktreePath;
    const matches = projects.filter(project => project.hostId === target.hostId && nonempty(project.projectId)
      && nonempty(project.path) && samePath(project.path, actual.worktreePath)
      && (!target.hostProjectId || project.projectId === target.hostProjectId));
    if (matches.length > 1) { item.reason = 'HOST_PROJECT_AMBIGUOUS'; item.candidateIds = matches.map(project => project.projectId); continue; }
    if (matches.length === 1) { item.status = 'ready'; item.hostProjectId = matches[0].projectId; continue; }
    if (target.hostProjectId) { item.reason = 'HOST_PROJECT_ID_OR_PATH_MISMATCH'; continue; }
    if (!authorized(state, 'createChat', target)) { item.reason = 'CREATE_CHAT_AUTHORIZATION_REQUIRED'; continue; }
    const native = capabilities.createProject, ui = capabilities.computerUse;
    if (native?.status === 'available' && nonempty(native.toolName) && nonempty(native.evidence)) {
      item.action = { route: 'native', toolName: native.toolName, evidence: native.evidence };
    } else if (target.hostId === 'local' && ui?.status === 'available' && nonempty(ui.evidence)) {
      item.action = { route: 'computerUse', evidence: ui.evidence };
    } else {
      item.reason = 'HOST_PROJECT_AUTOMATION_UNAVAILABLE';
      item.capabilities = clone(capabilities);
      continue;
    }
    item.status = 'needsCreation';
    Object.assign(item.action, { hostId: target.hostId, path: actual.worktreePath, label: target.label ?? target.lineId });
  }
  return { date: state.date, ready: results.every(item => item.status === 'ready'), projects: results };
}

export async function stageHostProject(state, input, checkpoint, inspect = inspectWorktree) {
  check(typeof checkpoint === 'function', 'DURABLE_CHECKPOINT_REQUIRED');
  const plan = await planHostProjects(state, { ...input, targets: [input.target] }, inspect);
  const item = plan.projects[0];
  const operationId = `${state.id}/project/${fingerprint([item.hostId, pathKey(item.worktreePath)])}`;
  const existing = state.operations.find(entry => entry.operationId === operationId);
  if (item.status === 'ready' && existing) {
    const operation = await verifyHostProject(state, { operationId, projects: input.projects,
      hostProjectId: item.hostProjectId, evidence: input.evidence }, checkpoint);
    return { ...item, operation, next: 'map', action: null };
  }
  // 成功/未知操作的原意图不随可用 UI/API 路径变化；恢复先回读，不能换路径重复添加。
  if (existing && (existing.status === 'succeeded' || existing.resultUnknown || existing.status === 'pending')) {
    return { ...item, operation: clone(existing), action: null, next: 'verify-project' };
  }
  if (item.status !== 'needsCreation') return { ...item, next: item.status === 'ready' ? 'map' : 'resolveCapability', action: null };
  const operation = { operationId, kind: 'createProject', request: { hostId: item.hostId, path: item.worktreePath },
    explicitUserAuthorization: true };
  let staged = false;
  const entry = await runHostOperation(state, operation, { createProject: async () => {
    staged = true;
    throw Object.assign(Error('PROJECT_AUTOMATION_PENDING'), { resultUnknown: true });
  } }, checkpoint);
  return { ...item, operation: entry, action: staged ? item.action : null, next: 'verify-project' };
}

export async function verifyHostProject(state, { operationId, projects, evidence, hostProjectId }, checkpoint) {
  check(typeof checkpoint === 'function', 'DURABLE_CHECKPOINT_REQUIRED');
  const entry = state.operations.find(item => item.operationId === operationId);
  check(entry?.intent.kind === 'createProject' && nonempty(evidence) && Array.isArray(projects), 'HOST_PROJECT_VERIFICATION_REQUIRED');
  const request = entry.intent.request;
  const matches = projects.filter(project => project.hostId === request.hostId && nonempty(project.projectId)
    && nonempty(project.path) && samePath(project.path, request.path)
    && (!hostProjectId || project.projectId === hostProjectId)
    && (!entry.targetId || project.projectId === entry.targetId));
  check(matches.length === 1, matches.length ? 'HOST_PROJECT_AMBIGUOUS' : 'HOST_PROJECT_NOT_CONFIRMED');
  if (entry.status === 'succeeded') return clone(entry);
  entry.status = 'succeeded'; entry.resultUnknown = false; entry.targetId = matches[0].projectId;
  entry.result = { targetId: entry.targetId, hostId: request.hostId, path: matches[0].path, evidence };
  if (entry.attempts.at(-1)) entry.attempts.at(-1).status = 'succeeded';
  delete entry.reason;
  await checkpoint(state);
  return clone(entry);
}
function passed(snapshot, step, seen = new Set()) {
  if (!step || seen.has(step.key)) return false;
  seen.add(step.key);
  return step.status === 'completed' && step.acceptance === 'passed'
    && !(step.blockers ?? []).some(item => !item.resolved)
    && (step.conditions ?? []).filter(item => item.required).every(item => item.result === 'passed' && item.evidenceIds.length
      && item.evidenceIds.every(id => step.evidence.some(proof => proof.evidenceId === id && proof.result === 'passed')))
    && snapshot.steps.filter(item => item.parentKey === step.key && item.required).every(item => passed(snapshot, item, new Set(seen)));
}
function scopedSteps(state, task, snapshot) {
  const project = snapshot?.projects?.find(item => item.id === state.projectId);
  const plan = snapshot?.plans?.find(item => item.id === state.planId && item.projectKey === project?.key);
  check(project && plan, 'SERVICE_REGISTRATION_REQUIRED');
  const steps = task.stepIds.map(id => snapshot.steps.find(item => item.id === id && item.planKey === plan.key));
  check(steps.length && steps.every(Boolean), 'STEP_SCOPE_MISMATCH');
  return steps;
}
function dependencyIssues(state, task, snapshot) {
  const steps = scopedSteps(state, task, snapshot), issues = [];
  for (const step of steps) {
    const parent = snapshot.steps.find(item => item.key === step.parentKey);
    for (const key of [...step.dependsOn, ...(parent?.dependsOn ?? [])]) if (!passed(snapshot, snapshot.steps.find(item => item.key === key))) issues.push(`DEPENDENCY:${key}`);
    if (parent && parent.status !== 'running') issues.push(`PARENT:${parent.key}`);
    if ((step.blockers ?? []).some(item => !item.resolved)) issues.push(`BLOCKER:${step.id}`);
    if (!['pending', 'running'].includes(step.status)) issues.push(`STEP_REQUIRES_REVIEW:${step.id}`);
  }
  return issues;
}
function shared(a, b) {
  if (a.hostId === b.hostId && samePath(a.worktreePath, b.worktreePath)) return 'SHARED_WORKTREE';
  for (const left of a.resources ?? []) for (const right of b.resources ?? []) {
    if (left.key === right.key && (left.mode !== 'read' || right.mode !== 'read')) return `SHARED_RESOURCE:${left.key}`;
  }
  return null;
}
const activeTasks = state => state.batches.flatMap(batch => batch.tasks.filter(task => !['verified', 'cancelled'].includes(task.state)));
export function planBatch(state, { id, tasks }, snapshot) {
  const intentHash = fingerprint(tasks);
  const existing = state.batches.find(item => item.id === id);
  if (existing) { check(existing.intentHash === intentHash, 'BATCH_IDEMPOTENCY_CONFLICT'); return clone(existing); }
  const batch = { id, intentHash, tasks: [], deferred: [] };
  const occupied = activeTasks(state).map(task => ({ task, mapping: mappingFor(state, task.lineId) }));
  for (const task of tasks) {
    check(nonempty(task.id) && nonempty(task.lineId) && task.stepIds?.length && task.spec, 'TASK_SCOPE_REQUIRED');
    const reasons = [];
    check(!state.batches.some(batch => batch.tasks.some(item => item.id === task.id)), 'TASK_ID_ALREADY_USED');
    if (!authorized(state, 'dispatch', task) || !authorized(state, 'collect', task)) reasons.push('COORDINATION_AUTHORIZATION_REQUIRED');
    if (state.batches.length && !authorized(state, 'continue', task)) reasons.push('SUCCESSOR_AUTHORIZATION_REQUIRED');
    const mapping = mappingFor(state, task.lineId);
    if (!mapping) reasons.push('LINE_MAPPING_REQUIRED');
    else if (!task.stepIds.every(id => mapping.stepIds.includes(id))) reasons.push('LINE_STEP_SCOPE_MISMATCH');
    try { reasons.push(...dependencyIssues(state, task, snapshot)); } catch (error) { reasons.push(error.message); }
    if (mapping) for (const entry of occupied) {
      if (entry.task.stepIds.some(id => task.stepIds.includes(id))) reasons.push('STEP_ALREADY_ASSIGNED');
      const conflict = entry.mapping && shared({ ...mapping, resources: task.resources ?? [] }, { ...entry.mapping, resources: entry.task.resources ?? [] });
      if (conflict) reasons.push(conflict);
    }
    if (reasons.length) batch.deferred.push({ task: clone(task), reasons: [...new Set(reasons)] });
    else { const selected = { ...clone(task), state: 'prepared', threadId: task.threadId ?? null, hostId: mapping.hostId };
      batch.tasks.push(selected); occupied.push({ task: selected, mapping }); }
  }
  // 只读/生成模式只返回决策，不写批次或宿主意图。
  if (state.authorization.mode === 'execute') state.batches.push(clone(batch));
  return clone(batch);
}
function taskFor(state, batchId, taskId) {
  const task = state.batches.find(item => item.id === batchId)?.tasks.find(item => item.id === taskId);
  check(task, 'DISPATCH_TASK_NOT_FOUND'); return task;
}
export function taskPrompt(state, task, mapping) {
  const spec = task.spec;
  for (const field of ['title', 'goal', 'scope', 'sharedFiles', 'dependencies', 'versions', 'acceptance', 'stopConditions', 'receipt']) check(nonempty(spec[field]), `TASK_SPEC_REQUIRED:${field}`);
  const a = state.authorization;
  return `开始执行${spec.title}\n日期：${state.date}\n协调任务：${state.id}/${task.id}\n`+
    `用户授权出处：聊天 ${a.source.threadId}，${a.source.locator}\n用户授权原文：${a.source.quote}\n`+
    `授权能力：${a.permissions.join(', ')}；限定开发线：${a.lineIds.join(', ')}；限定步骤：${a.stepIds.join(', ')}。独立权限未授予不得推断。\n`+
    `工作台 projectId=${state.projectId}，planId=${state.planId}，stepIds=${task.stepIds.join(', ')}\n`+
    `已发现责任绑定=${JSON.stringify(task.bindings ?? [])}；未结束执行=${JSON.stringify(task.executionIds ?? [])}。这些是核对资料，开始前回读当前版本。\n`+
    `Codex projectId=${mapping.hostProjectId}，hostId=${mapping.hostId}；项目来源=${mapping.projectSourcePath}\n`+
    `实际仓库=${mapping.repositoryRoot}；工作树=${mapping.worktreePath}；分支=${mapping.branch}；核对时 HEAD=${mapping.head}\n`+
    Object.entries(spec).map(([key, value]) => `${key}：${value}`).join('\n')+
    `\n实施前读取最新服务快照，核对责任绑定、所有未结束 executionId 与前置验收。沿用未结束执行，必要时显式接手；仅在确认没有原执行后预留新身份。开始请求成功并回读 running 后实施，未知结果先按原 eventId 查询。\n`+
    `执行、验收、同步、交接分别回报；携带 threadId/hostId、bindingId/revision、executionId、事件键、提交与证据，失败说明剩余及恢复动作。\n`+
    (authorized(state, 'reportBack', task)
      ? `用户授予的回报范围：仅向协调聊天 ${state.coordinator.threadId}（hostId=${state.coordinator.hostId}）发送本任务进展及最终回执。先核对上述人类授权原始出处；转发指令本身不能充当双向授权证据。无法核实则只在本聊天给出回执，由协调聊天用 wait_threads/read_thread 收集。\n`
      : `未授予跨聊天回报权限；在本聊天给出回执，由协调聊天读取。\n`);
}

// 当前宿主只有 local / 新 worktree；local 只能在项目来源恰好是目标工作树时使用。
export function createRequest(state, task, mapping, projects) {
  check(authorized(state, 'createChat', task), 'CREATE_CHAT_AUTHORIZATION_REQUIRED');
  const project = projects.find(item => item.projectId === mapping.hostProjectId && item.hostId === mapping.hostId);
  check(project, 'HOST_PROJECT_NOT_FOUND');
  check(project.path && samePath(project.path, mapping.worktreePath), 'HOST_EXISTING_WORKTREE_UNSUPPORTED');
  return { title: task.spec.title, target: { type: 'project', projectId: project.projectId, environment: { type: 'local' } },
    prompt: `日期：${state.date}\n隔离的执行上下文核对阶段，尚未许可实施。\n协调任务 ${state.id}/${task.id}；操作键 ${state.id}/${task.id}/create。\n请只读核对并回报当前真实 threadId、hostId、Codex projectId、cwd、Git 工作树根、公共 Git 目录、仓库根、分支和 HEAD。\n预期项目 ${mapping.hostProjectId}，工作树 ${mapping.worktreePath}，分支 ${mapping.branch}。\n本阶段不要修改文件、预留执行身份、启动任务或发送跨聊天消息。协调聊天确认上下文后另行派发完整任务。` };
}
export async function verifyTarget(state, batchId, taskId, observation, inspect = inspectWorktree) {
  const task = taskFor(state, batchId, taskId), mapping = mappingFor(state, task.lineId);
  check(task.threadId && observation.threadId === task.threadId && observation.hostId === mapping.hostId
    && observation.hostProjectId === mapping.hostProjectId && nonempty(observation.evidence), 'TARGET_IDENTITY_UNCONFIRMED');
  check(samePath(observation.worktreePath, mapping.worktreePath) && observation.branch === mapping.branch, 'TARGET_WORKTREE_MISMATCH');
  const actual = await inspect(observation.worktreePath, observation.branch);
  check(samePath(actual.repositoryRoot, mapping.repositoryRoot) && samePath(actual.gitCommonDir, mapping.gitCommonDir), 'TARGET_REPOSITORY_MISMATCH');
  task.targetEvidence = { ...clone(observation), ...actual };
  task.state = 'contextVerified';
  const entry = state.mappings.find(item => item.mapping.lineId === task.lineId);
  state.mappingHistory.push(clone(entry));
  entry.mapping = { ...mapping, threadId: task.threadId, ...actual };
  return clone(task);
}
function delivered(result) {
  check(result && result.isError !== true, 'HOST_RESULT_REJECTED');
  if (result.structuredContent) return result.structuredContent;
  const content = result.content?.find(item => item.type === 'text')?.text;
  if (content) { try { return JSON.parse(content); } catch { throw Error('HOST_RESULT_UNSTRUCTURED'); } }
  return result;
}
export function nativeAdapter(call) {
  const invoke = async (name, request) => {
    try { return delivered(await call(name, request)); }
    catch (error) { throw Object.assign(error, { resultUnknown: true }); }
  };
  return {
    createChat: async operation => {
      const result = await invoke('create_thread', operation.request);
      if (result.clientThreadId && !result.threadId) throw Object.assign(Error('HOST_SETUP_PENDING'), { resultUnknown: true });
      if (!nonempty(result.threadId) || !nonempty(result.hostId)) throw Object.assign(Error('HOST_THREAD_ID_REQUIRED'), { resultUnknown: true });
      return { targetId: result.threadId, threadId: result.threadId, hostId: result.hostId, raw: result };
    },
    sendMessage: async operation => {
      const result = await invoke('send_message_to_thread', operation.request);
      if (result.threadId !== operation.request.threadId) throw Object.assign(Error('HOST_DELIVERY_UNCONFIRMED'), { resultUnknown: true });
      // 具体回执结构由当前宿主适配器核验；投递成功仍需独立观察执行开始。
      return { targetId: operation.request.threadId, raw: result };
    },
    // 宿主未提供幂等键/按 operationId 查询；未知结果不自动重发。
    reconcile: async () => ({ state: 'unknown' }),
  };
}
// 对模型可用的原生工具采用两段操作：先持久化返回真实 schema 请求，调用后保存真实结果。
// 此脚本不会绕过宿主、模拟项目归属或自行启动 app-server。
export async function stageDispatch(state, batchId, taskId, options) {
  let staged = null;
  const stage = async operation => { staged = clone(operation); throw Object.assign(Error('NATIVE_CALL_PENDING'), { resultUnknown: true }); };
  const result = await dispatchTask(state, batchId, taskId, { ...options,
    adapter: { createChat: stage, sendMessage: stage, reconcile: async () => ({ state: 'unknown' }) } });
  return { ...result, nativeCall: staged ? { operationId: staged.operationId,
    name: staged.kind === 'createChat' ? 'create_thread' : 'send_message_to_thread', arguments: staged.request } : null };
}
export async function recordNativeResult(state, { operationId, result, evidence }, checkpoint) {
  const entry = state.operations.find(item => item.operationId === operationId);
  check(entry && nonempty(evidence), 'ORIGINAL_OPERATION_EVIDENCE_REQUIRED');
  if (entry.status === 'succeeded') return clone(entry);
  const adapter = nativeAdapter(async () => result);
  try {
    const value = await adapter[entry.intent.kind](entry.intent);
    entry.targetId = value.targetId; entry.result = value; entry.status = 'succeeded'; entry.resultUnknown = false;
    entry.evidence = evidence;
    if (entry.attempts.at(-1)) entry.attempts.at(-1).status = 'succeeded';
    delete entry.reason;
  } catch (error) { entry.status = 'pending'; entry.resultUnknown = true; entry.reason = error.message; entry.rawResult = clone(result); }
  await checkpoint(state); return clone(entry);
}
export async function reconcileNotSubmitted(state, { operationId, proof, evidence }, checkpoint) {
  const entry = state.operations.find(item => item.operationId === operationId);
  check(entry && entry.status !== 'succeeded' && ['explicitRejection', 'nativeRequestNotInvoked'].includes(proof)
    && nonempty(evidence), 'NON_SUBMISSION_PROOF_REQUIRED');
  check(!entry.targetId, 'PARTIAL_SUCCESS_REQUIRES_TARGET_RECONCILIATION');
  entry.reconciliations ??= []; entry.reconciliations.push({ proof, evidence, at: new Date().toISOString() });
  entry.resultUnknown = false; entry.status = 'failed'; entry.reason = 'VERIFIED_NOT_SUBMITTED';
  await checkpoint(state); return clone(entry);
}
export async function dispatchTask(state, batchId, taskId, { snapshot, projects, adapter, checkpoint, inspect = inspectWorktree }) {
  const task = taskFor(state, batchId, taskId), mapping = mappingFor(state, task.lineId);
  if (task.state === 'verified') return { state: 'verified', next: 'reviewSuccessors' };
  check(authorized(state, 'dispatch', task) && authorized(state, 'collect', task), 'COORDINATION_AUTHORIZATION_REQUIRED');
  check(typeof checkpoint === 'function', 'DURABLE_CHECKPOINT_REQUIRED');
  if (state.operations.some(item => item.operationId === `${state.id}/${task.id}/dispatch` && item.status === 'succeeded')) {
    if (task.state === 'contextVerified') { task.state = 'delivered'; await checkpoint(state); }
    return { state: task.state, next: 'wait_threads' };
  }
  taskPrompt(state, task, mapping); // 创建前保证派发内容完整、可审阅。
  check(!dependencyIssues(state, task, snapshot).length, 'DEPENDENCY_NOT_READY');
  check(!state.unconfirmedEvents.some(item => !item.resolved && (!item.stepIds || item.stepIds.some(id => task.stepIds.includes(id)))), 'UNCONFIRMED_EVENT_REQUIRES_QUERY');
  for (const other of activeTasks(state).filter(item => item !== task)) {
    const otherMapping = mappingFor(state, other.lineId);
    const conflict = otherMapping && shared({ ...mapping, resources: task.resources ?? [] }, { ...otherMapping, resources: other.resources ?? [] });
    check(!conflict, conflict ?? 'SHARED_RESOURCE');
  }
  await inspect(mapping.worktreePath, mapping.branch);
  const steps = scopedSteps(state, task, snapshot);
  const openExecutions = snapshot.executions.filter(item => !item.endedAt && item.stepKeys.some(key => steps.some(step => step.key === key)));
  const owners = snapshot.bindings.filter(item => item.state === 'confirmed' && !item.revokedAt
    && steps.some(step => item.stepKeys.includes(step.key) || item.stepKeys.includes(step.parentKey)));
  task.bindings = owners.map(item => ({ bindingId: item.id, bindingRevision: item.bindingRevision }));
  const priorTargets = new Set([...owners.map(item => item.context.threadId), ...openExecutions.map(item => snapshot.bindings.find(b => b.key === item.bindingKey)?.context.threadId)].filter(Boolean));
  check(priorTargets.size <= 1, 'RESPONSIBILITY_REVIEW_REQUIRED');
  if (priorTargets.size) {
    const prior = [...priorTargets][0];
    check(!task.threadId || task.threadId === prior, 'TAKEOVER_REQUIRED');
    task.threadId = prior; task.executionIds = openExecutions.map(item => item.id);
  }
  if (!task.threadId) {
    const operation = { operationId: `${state.id}/${task.id}/create`, kind: 'createChat', explicitUserAuthorization: true,
      request: createRequest(state, task, mapping, projects) };
    const entry = await runHostOperation(state, operation, adapter, checkpoint);
    if (entry.status === 'succeeded') {
      check(entry.result.hostId === mapping.hostId, 'TARGET_HOST_MISMATCH');
      task.threadId = entry.targetId; task.hostId = entry.result.hostId; task.state = 'created'; await checkpoint(state);
    }
    return { state: task.state, operation: entry, next: 'verifyTarget' };
  }
  check(task.targetEvidence, 'TARGET_IDENTITY_UNCONFIRMED');
  // 上下文和依赖必须再次核对。复用同一个任务的发送键，恢复时不会重复派发。
  const operation = { operationId: `${state.id}/${task.id}/dispatch`, kind: 'sendMessage', explicitUserAuthorization: true,
    request: { threadId: task.threadId, hostId: task.hostId, prompt: taskPrompt(state, task, mapping) } };
  const entry = await runHostOperation(state, operation, adapter, checkpoint);
  if (entry.status === 'succeeded') { task.state = 'delivered'; await checkpoint(state); }
  return { state: task.state, operation: entry, next: 'wait_threads' };
}
export function observeTask(state, batchId, taskId, { snapshot, receipt, cursor, evidence }) {
  const task = taskFor(state, batchId, taskId);
  check(authorized(state, 'collect', task) && nonempty(evidence), 'OBSERVATION_AUTHORIZATION_REQUIRED');
  const steps = scopedSteps(state, task, snapshot), mapping = mappingFor(state, task.lineId);
  const bindings = steps.map(step => snapshot.bindings.find(item => item.key === step.bindingKey));
  const executions = steps.map(step => snapshot.executions.find(item => item.key === step.executionKey));
  const matched = bindings.every(item => item?.state === 'confirmed' && !item.revokedAt
    && item.context.threadId === task.threadId && item.context.hostId === task.hostId
    && item.context.folderId === mapping.hostProjectId && item.context.branch === mapping.branch
    && samePath(item.context.worktreePath, mapping.worktreePath));
  const started = matched && executions.every((item, i) => item?.startedAt && item.bindingKey === bindings[i].key);
  const receiptMatches = receipt?.threadId === task.threadId && receipt?.hostId === task.hostId
    && receipt?.projectId === state.projectId && receipt?.planId === state.planId
    && fingerprint([...(receipt.stepIds ?? [])].sort()) === fingerprint([...task.stepIds].sort())
    && executions.every(item => item && receipt.executionIds?.includes(item.id));
  const verified = started && receiptMatches && steps.every(step => passed(snapshot, step) && step.sync === 'synced')
    && executions.every(item => item.endedAt) && receipt?.evidenceVerified === true && nonempty(receipt.evidence);
  const status = verified ? 'verified' : receipt && !receiptMatches ? 'receiptReview' : steps.some(step => step.status === 'blocked')
    ? 'blocked' : started ? 'started' : 'awaitingStart';
  const observation = { taskId, threadId: task.threadId, hostId: task.hostId, status, executionIds: executions.filter(Boolean).map(item => item.id),
    execution: steps.map(step => step.status), acceptance: steps.map(step => step.acceptance), sync: steps.map(step => step.sync),
    handoff: receipt?.handoff ?? null, receipt: clone(receipt ?? null), evidence };
  const previous = [...state.observations].reverse().find(item => item.taskId === taskId);
  const changed = !previous || fingerprint(observation) !== fingerprint(previous);
  if (changed) state.observations.push(observation);
  task.state = status; task.executionIds = observation.executionIds; task.cursor = cursor ?? task.cursor;
  task.bindings = bindings.filter(Boolean).map(item => ({ bindingId: item.id, bindingRevision: item.bindingRevision }));
  return { changed, ...clone(observation) };
}
export function recoveryReport(state) {
  const assignedIds = new Set(state.batches.flatMap(batch => batch.tasks.map(task => task.id)));
  return { coordinator: clone(state.coordinator), authorization: clone(state.authorization),
    unfinished: activeTasks(state).map(task => ({ batchId: state.batches.find(batch => batch.tasks.includes(task)).id, taskId: task.id,
      lineId: task.lineId, state: task.state, threadId: task.threadId, hostId: task.hostId, executionIds: task.executionIds ?? [], cursor: task.cursor ?? null })),
    unknownOperations: state.operations.filter(item => item.resultUnknown || item.status === 'pending').map(clone),
    unconfirmedEvents: clone(state.unconfirmedEvents), pendingReceipts: state.observations.filter(item => item.status === 'receiptReview').map(clone),
    deferred: state.batches.flatMap(batch => batch.deferred.filter(item => !assignedIds.has(item.task.id)).map(item => ({ batchId: batch.id, ...clone(item) }))) };
}

// 本地检查点可独立恢复；服务未登记时仍可保存缺项。所有外部调用先保存操作意图。
export async function saveCheckpoint(file, state) {
  validateCoordination(state); await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(state, null, 2) + '\n', 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, file); } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export async function withCheckpoint(file, action) {
  const lock = await open(`${file}.lock`, 'wx', 0o600);
  try { await lock.writeFile(JSON.stringify({ pid: process.pid, date: new Date().toISOString() }));
    const state = validateCoordination(JSON.parse(await readFile(file, 'utf8')));
    const result = await action(state, next => saveCheckpoint(file, next)); await saveCheckpoint(file, state); return result;
  } finally { await lock.close(); await unlink(`${file}.lock`); }
}
export async function coordinationCli(argv = process.argv.slice(2)) {
  const [command, file, inputFile] = argv;
  check(file, 'USAGE: node coordination-cli.mjs <init|recover|projects|stage-project|verify-project|map|plan|stage|record|reconcile|adopt|verify|observe> <checkpoint.json> [input.json]');
  const input = inputFile ? JSON.parse(await readFile(inputFile, 'utf8')) : null;
  let result;
  if (command === 'init') {
    // 独占创建，拒绝覆盖已有恢复记录。
    const handle = await open(file, 'wx', 0o600);
    try { const state = createCoordination(input); await handle.writeFile(JSON.stringify(state, null, 2) + '\n'); await handle.sync(); result = recoveryReport(state); }
    finally { await handle.close(); }
  } else if (command === 'recover') result = recoveryReport(validateCoordination(JSON.parse(await readFile(file, 'utf8'))));
  else result = await withCheckpoint(file, async (state, checkpoint) => {
    if (command === 'projects') return planHostProjects(state, input);
    if (command === 'stage-project') return stageHostProject(state, input, checkpoint);
    if (command === 'verify-project') return verifyHostProject(state, input, checkpoint);
    if (command === 'map') return mapLine(state, input.mapping, input.projects);
    if (command === 'plan') return planBatch(state, input.batch, input.snapshot);
    if (command === 'stage') return stageDispatch(state, input.batchId, input.taskId, { ...input, checkpoint });
    if (command === 'record') return recordNativeResult(state, input, checkpoint);
    if (command === 'reconcile') return reconcileNotSubmitted(state, input, checkpoint);
    if (command === 'adopt') return adoptCoordination(state, input);
    if (command === 'verify') return verifyTarget(state, input.batchId, input.taskId, input.observation);
    if (command === 'observe') return observeTask(state, input.batchId, input.taskId, input);
    throw Error('UNKNOWN_COORDINATION_COMMAND');
  });
  console.log(JSON.stringify(result, null, 2));
}
