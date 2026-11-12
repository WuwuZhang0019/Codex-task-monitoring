// 日期 2026-11-10。可信适配器负责授权、发布确认和绑定确认，领域入口负责原子业务门禁。
import { randomUUID } from 'node:crypto';
import { digest } from './receipts.mjs';
import { requireLightShape, validateLightSnapshot, lightError, transitions, unique,
  requiredConditions, childrenOf, dependenciesOf, waitingFor, planProgress } from './light-model.mjs';
import { legacyLightStatus } from './light-import.mjs';
import { touches } from './light-library.mjs';
import { validateCoordination } from '../../plugins/task-workbench/skills/workbench-handoff/scripts/coordination.mjs';

const now = () => new Date().toISOString();
const dateOf = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const entityGroups = ['projects', 'plans', 'steps', 'routes', 'bindings', 'executions', 'supplements'];
function empty() {
  const time = now();
  return { version: 1, metadata: {}, history: [], snapshot: { schemaVersion: 'light-1.0', date: dateOf(time), mode: 'service', revision: 0,
    generatedAt: time, projects: [], plans: [], steps: [], routes: [], bindings: [], executions: [], supplements: [], events: [],
    uiPreferences: { collapsedKeys: [], selectedStepKey: null, focusedRouteKey: null, scrollByProject: {} } } };
}
function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) lightError('INVALID_INPUT', label);
}
function applyChecks(step, checks, evidence) {
  unique(checks.map(item => item.conditionId), '重复验收检查');
  unique(evidence.map(item => item.evidenceId), '重复证据');
  const configured = new Map(step.conditions.map(item => [item.conditionId, item]));
  for (const check of checks) {
    const original = configured.get(check.conditionId);
    if (!original || original.text !== check.text || original.required !== check.required) lightError('EVIDENCE_MISMATCH', '验收条件必须匹配服务配置');
  }
  const versions = new Set(evidence.filter(item => item.result === 'passed').map(item => item.deliveryVersion));
  if (versions.size !== 1) lightError('EVIDENCE_MISMATCH', '完成证据必须引用同一当前交付版本');
  step.conditions = step.conditions.map(item => checks.find(check => check.conditionId === item.conditionId) ?? { ...item, result: 'pending', evidenceIds: [] });
  step.evidence = structuredClone(evidence);
  if (!requiredConditions(step.conditions, step.evidence)) lightError('EVIDENCE_MISMATCH', '全部必要验收条件及证据未满足');
}
function activeBinding(snapshot, step, input) {
  const binding = snapshot.bindings.find(item => item.id === input.bindingId);
  if (!binding || binding.state !== 'confirmed' || binding.revokedAt || binding.bindingRevision !== input.bindingRevision
    || binding.planKey !== step.planKey || !binding.stepKeys.includes(step.key) && !binding.stepKeys.includes(step.parentKey)) {
    lightError('STALE_BINDING', '有效责任绑定不匹配', 409);
  }
  return binding;
}
function canRun(snapshot, step, allowCompletedParent = false) {
  const waiting = waitingFor(snapshot, step);
  const parent = snapshot.steps.find(item => item.key === step.parentKey);
  const parentReady = !parent || parent.status === 'running' || allowCompletedParent && parent.status === 'completed';
  if (waiting.length || !parentReady) lightError('DEPENDENCY_NOT_READY', [...waiting, ...(!parentReady ? [parent.key] : [])].join(', '), 409);
  if (step.blockers.some(item => !item.resolved)) lightError('BLOCKER_NOT_RESOLVED', step.key, 409);
}
function addBlocker(step, blocker) {
  const previous = step.blockers.find(item => item.blockerId === blocker.blockerId);
  if (previous && digest(previous) !== digest(blocker)) lightError('INVALID_INPUT', '阻塞身份已存在');
  if (!previous) step.blockers.push(structuredClone(blocker));
}
function invalidateSuccessors(snapshot, origin, reason, time) {
  const affected = new Set([origin.key]);
  if (origin.parentKey) affected.add(origin.parentKey);
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of snapshot.steps) {
      if (affected.has(step.key)) continue;
      if (dependenciesOf(snapshot, step).some(key => affected.has(key))) {
        affected.add(step.key); changed = true;
      }
    }
  }
  for (const key of affected) {
    const step = snapshot.steps.find(item => item.key === key);
    if (key === origin.key || step.status === 'pending' || step.status === 'cancelled') continue;
    step.acceptance = 'recheck'; step.updatedAt = time;
    if (step.status === 'completed') step.status = 'blocked';
    if (step.status === 'running') step.status = 'blocked';
    const blockerId = `dependency:${origin.key}`;
    const previous = step.blockers.find(item => item.blockerId === blockerId);
    if (previous) { previous.reason = reason; previous.resolved = false; }
    else addBlocker(step, { blockerId, reason, waitingFor: [origin.key], releaseConditions: ['前置重新验收且显式确认后继复核'], resolved: false });
  }
}

export function createLightService(persistence, requests, {
  authorize = () => false, confirmBinding = () => false, verifyExecutionContext = () => true,
  automaticBinding = () => false,
} = {}) {
  function permitted(principal, projectId, operation, details = {}) {
    if (!principal || authorize(principal, projectId, operation, details) !== true) lightError('FORBIDDEN', '适配层未授予当前作用域', 403);
    if (touches(details.input, new Set(persistence.read('lightDeletedKeys') ?? []))) lightError('DELETED_TASK', '此任务已删除，旧请求不能重新写入', 410);
  }
  function load() { return persistence.read('light') ?? empty(); }
  function scope(snapshot, input) {
    const project = snapshot.projects.find(item => item.id === input.projectId);
    const plan = snapshot.plans.find(item => item.id === input.planId && item.projectKey === project?.key);
    if (!project || !plan) lightError('NOT_FOUND', '项目或方案归属不匹配', 404);
    return { project, plan };
  }
  function save(value, project, eventId, receivedAt) {
    project.revision += 1;
    value.snapshot.revision += 1;
    value.snapshot.generatedAt = receivedAt;
    value.snapshot.date = dateOf(receivedAt);
    validateLightSnapshot(value.snapshot);
    persistence.write('light', value);
    return { revision: project.revision, receipt: { schemaVersion: 'light-1.0', eventId, requestId: randomUUID(), status: 'committed',
      committedRevision: project.revision, receivedAt, resultRef: `light/events/${eventId}`, errorCode: null, recovery: '读取已提交快照或查询原事件' } };
  }
  function history(value, input, step, fromStatus, executionKey, receivedAt, eventScope) {
    value.snapshot.events.push({ eventId: `light/${eventScope}/${input.eventId}`, stepKey: step?.key ?? null, executionKey,
      fromStatus, toStatus: step?.status ?? null, occurredAt: input.occurredAt, receivedAt,
      reason: input.reason, evidenceIds: (input.evidence ?? []).map(item => item.evidenceId), sync: 'synced' });
    value.history.push({ eventId: input.eventId, input: structuredClone(input), previous: fromStatus, receivedAt });
  }
  function commit(principal, operation, input, transform, shape) {
    if (shape) requireLightShape(shape, input);
    text(input.eventId, 'eventId');
    permitted(principal, input.projectId, operation, { input });
    scope(load().snapshot, input);
    return requests.execute(principal, input.projectId, `light.${operation}`, { ...input, idempotencyKey: input.eventId }, async () => {
      const value = load(), { project, plan } = scope(value.snapshot, input);
      if (project.revision !== input.expectedRevision) lightError('REVISION_CONFLICT', `当前版本 ${project.revision}`, 409);
      if (input.source && ['path', 'version', 'sha256'].some(key => input.source[key] !== plan.source[key])) lightError('STALE_PLAN', '来源路径、版本或指纹与已登记方案不一致', 409);
      const receivedAt = now();
      const result = await transform(value, project, plan, receivedAt, digest([principal, input.projectId, operation]));
      return { ...save(value, project, input.eventId, receivedAt), ...result };
    }, () => { permitted(principal, input.projectId, operation, { input }); scope(load().snapshot, input); });
  }
  return {
    // 日期：2026-11-12。复用项目权限、聚合事务、事件查询和版本冲突处理。
    readCoordination(principal, input) {
      permitted(principal, input.projectId, 'read');
      const value = load(); scope(value.snapshot, input);
      const checkpoint = value.metadata.coordinations?.find(item => item.projectId === input.projectId
        && item.planId === input.planId && item.id === input.coordinationId);
      return { checkpoint: structuredClone(checkpoint ?? null) };
    },
    saveCoordination(principal, input) {
      return commit(principal, 'coordinate', input, (value, project, plan, time) => {
        value.metadata.coordinations ??= [];
        const previous = value.metadata.coordinations.find(item => item.projectId === project.id && item.planId === plan.id && item.id === input.coordinationId);
        if ((previous?.revision ?? 0) !== input.expectedCheckpointRevision) lightError('REVISION_CONFLICT', '协调检查点已更新', 409);
        try { validateCoordination(input.state, previous?.state); } catch (error) { lightError('INVALID_INPUT', error.message); }
        if (input.state.projectId !== project.id || input.state.planId !== plan.id || input.state.id !== input.coordinationId) lightError('INVALID_INPUT', '协调身份不匹配');
        const mappedStepIds = input.state.mappings.flatMap(item => item.mapping.stepIds);
        const taskStepIds = input.state.batches.flatMap(batch => batch.tasks.flatMap(task => task.stepIds));
        if ([...mappedStepIds, ...taskStepIds].some(id => !value.snapshot.steps.some(step => step.id === id && step.planKey === plan.key))) lightError('INVALID_INPUT', '协调步骤归属不匹配');
        const checkpoint = { id: input.coordinationId, projectId: project.id, planId: plan.id,
          revision: (previous?.revision ?? 0) + 1, state: structuredClone(input.state), updatedAt: time };
        if (previous) value.metadata.coordinations.splice(value.metadata.coordinations.indexOf(previous), 1, checkpoint);
        else value.metadata.coordinations.push(checkpoint);
        return { checkpointRevision: checkpoint.revision };
      });
    },
    read(principal, projectId) {
      permitted(principal, projectId, 'read');
      const snapshot = load().snapshot;
      const project = snapshot.projects.find(item => item.id === projectId || item.key === projectId);
      if (!project) lightError('NOT_FOUND', projectId, 404);
      const projectKeys = new Set([project.key]);
      for (const key of projectKeys) {
        for (const supplement of snapshot.supplements.filter(item => snapshot.steps.some(step => step.key === item.sourceStepKey && step.projectKey === key))) {
          const linkedPlan = snapshot.plans.find(item => item.key === supplement.linkedPlanKey);
          if (linkedPlan && !projectKeys.has(linkedPlan.projectKey)) {
            const linkedProject = snapshot.projects.find(item => item.key === linkedPlan.projectKey);
            permitted(principal, linkedProject.id, 'read'); projectKeys.add(linkedProject.key);
          }
        }
      }
      const view = structuredClone(snapshot);
      view.projects = view.projects.filter(item => projectKeys.has(item.key));
      for (const group of ['plans', 'steps', 'routes', 'bindings', 'executions']) view[group] = view[group].filter(item => projectKeys.has(item.projectKey));
      view.supplements = view.supplements.filter(item => view.steps.some(step => step.key === item.sourceStepKey));
      view.events = view.events.filter(item => view.steps.some(step => step.key === item.stepKey) || view.executions.some(execution => execution.key === item.executionKey));
      view.uiPreferences = { ...view.uiPreferences, collapsedKeys: view.uiPreferences.collapsedKeys.filter(key => view.steps.some(step => step.key === key)),
        selectedStepKey: view.steps.some(step => step.key === view.uiPreferences.selectedStepKey) ? view.uiPreferences.selectedStepKey : null,
        focusedRouteKey: view.routes.some(route => route.key === view.uiPreferences.focusedRouteKey) ? view.uiPreferences.focusedRouteKey : null,
        scrollByProject: Object.fromEntries(Object.entries(view.uiPreferences.scrollByProject).filter(([key]) => projectKeys.has(key))) };
      return structuredClone(validateLightSnapshot(view));
    },
    progress(principal, projectId, planId) {
      const snapshot = this.read(principal, projectId);
      const project = snapshot.projects.find(item => item.id === projectId);
      const plan = snapshot.plans.find(item => item.id === planId && item.projectKey === project.key);
      if (!plan) lightError('NOT_FOUND', planId, 404);
      return { ...planProgress(snapshot, plan.key), routes: snapshot.routes.filter(item => item.planKey === plan.key).map(route => ({ key: route.key,
        completed: route.stepKeys.every(key => { const step = snapshot.steps.find(item => item.key === key); return !step.required || step.status === 'completed' && step.acceptance === 'passed'; }),
        runnable: route.stepKeys.filter(key => { const step = snapshot.steps.find(item => item.key === key); return step.status === 'pending' && !waitingFor(snapshot, step).length && !step.blockers.some(item => !item.resolved); }) })) };
    },
    query(principal, projectId, operation, eventId) {
      permitted(principal, projectId, 'query');
      // 首次登记以本地 projectKey 去重，成功后调用者持有服务 projectId。
      const project = load().snapshot.projects.find(item => item.id === projectId);
      const scopeId = operation === 'register' && project ? project.key : projectId;
      if (['register', 'revise'].includes(operation)) {
        const publication = requests.query(principal, scopeId, `light.publish.${operation}`, eventId);
        if (publication.state === 'committed') return publication;
      }
      const result = requests.query(principal, scopeId, `light.${operation}`, eventId);
      if (operation === 'update' && result.state === 'unknown') {
        const late = load().metadata.lateReceipts?.find(item => item.key === digest([principal, projectId, eventId]));
        if (late) return { state: 'pendingReview', result: structuredClone(late) };
      }
      return result;
    },
    register(principal, input) {
      text(input.eventId, 'eventId');
      const candidate = validateLightSnapshot(structuredClone(input.snapshot));
      if (candidate.projects.length !== 1 || candidate.bindings.length || candidate.executions.length || candidate.events.length || candidate.supplements.length
        || candidate.steps.some(step => step.status !== 'pending' || step.evidence.length || step.blockers.length)) lightError('INVALID_INPUT', '登记只接受未执行的单项目方案');
      const projectKey = candidate.projects[0].key;
      permitted(principal, projectKey, 'register', { input });
      return requests.execute(principal, projectKey, 'light.register', { ...input, idempotencyKey: input.eventId }, async () => {
        const value = load();
        if (input.expectedRevision !== 0 || value.snapshot.projects.some(item => item.key === projectKey)) lightError('REVISION_CONFLICT', '项目已登记，使用修订入口', 409);
        for (const group of entityGroups) {
          for (const record of candidate[group]) { record.id = randomUUID(); value.snapshot[group].push(record); }
        }
        const project = candidate.projects[0]; project.revision = 0;
        value.metadata[digest(project.key)] = { source: candidate.plans.map(item => item.source), importedAt: now(), legacy: null, replacements: [] };
        return { ...save(value, project, input.eventId, now()), projectId: project.id, planIds: candidate.plans.map(item => item.id) };
      }, () => permitted(principal, projectKey, 'register', { input }));
    },
    // 由 D 的已确认发布入口调用。保留存在实体的状态、身份、历史及来源映射。
    revise(principal, input) {
      return commit(principal, 'revise', input, (value, project, plan, time) => {
        const candidate = validateLightSnapshot(structuredClone(input.snapshot));
        if (candidate.plans.length !== 1 || candidate.plans[0].key !== plan.key || candidate.projects[0]?.key !== project.key) lightError('INVALID_INPUT', '修订归属不匹配');
        const previous = value.snapshot.steps.filter(item => item.planKey === plan.key);
        if (previous.some(item => !candidate.steps.some(step => step.key === item.key))) lightError('HISTORY_REQUIRED', '删除步骤必须保留原身份及取消记录');
        const archivedKeys = new Set((persistence.read('lightLibrary')?.archived ?? []).map(item => item.key));
        for (const route of value.snapshot.routes.filter(item => item.planKey === plan.key && archivedKeys.has(item.key))) {
          const replacement = candidate.routes.find(item => item.key === route.key);
          if (!replacement || digest(replacement.stepKeys) !== digest(route.stepKeys)) {
            lightError('ARCHIVED_TASK', '请先恢复归档路线，再调整其结构', 409);
          }
        }
        for (const step of candidate.steps) {
          const old = previous.find(item => item.key === step.key);
          if (old && ['code', 'originalCode', 'parentKey'].some(key => old[key] !== step[key])) lightError('HISTORY_REQUIRED', '已登记步骤身份映射不可重写');
          if (old) {
            if (old.conditions.some(condition => condition.required && !step.conditions.some(item => item.conditionId === condition.conditionId && item.text === condition.text && item.required))) {
              lightError('HISTORY_REQUIRED', '修订必须保留已有必要验收，替代需明确批准');
            }
            const conditions = step.conditions.map(condition => {
              const previous = old.conditions.find(item => item.conditionId === condition.conditionId && item.text === condition.text && item.required === condition.required);
              return previous ?? { ...condition, result: 'pending', evidenceIds: [] };
            });
            Object.assign(step, { id: old.id, status: old.status, acceptance: old.acceptance, sync: old.sync, conditions,
              evidence: old.evidence, blockers: old.blockers, executionKey: old.executionKey, bindingKey: old.bindingKey, updatedAt: old.updatedAt });
          }
          else { if (step.status !== 'pending') lightError('INVALID_INPUT', '新增步骤必须待执行'); step.id = randomUUID(); }
        }
        value.history.push({ eventId: input.eventId, previousPlan: structuredClone(plan), previousSteps: previous, reason: input.reason, receivedAt: time });
        value.snapshot.steps = [...value.snapshot.steps.filter(item => item.planKey !== plan.key), ...candidate.steps];
        for (const route of candidate.routes) route.id = value.snapshot.routes.find(item => item.key === route.key)?.id ?? randomUUID();
        value.snapshot.routes = [...value.snapshot.routes.filter(item => item.planKey !== plan.key), ...candidate.routes];
        Object.assign(plan, { ...candidate.plans[0], id: plan.id });
        for (const step of candidate.steps.filter(item => item.status === 'completed' || item.status === 'running')) {
          const old = previous.find(item => item.key === step.key);
          if (digest(old?.dependsOn) !== digest(step.dependsOn) || digest(old?.conditions) !== digest(step.conditions)
            || candidate.steps.some(item => item.parentKey === step.key && !previous.some(oldStep => oldStep.key === item.key))) {
            step.status = 'blocked'; step.acceptance = 'recheck';
            addBlocker(step, { blockerId: `revision:${input.eventId}`, reason: input.reason, waitingFor: ['修订后复核'], releaseConditions: ['重新满足验收'], resolved: false });
            invalidateSuccessors(value.snapshot, step, input.reason, time);
          }
        }
        return { planId: plan.id };
      });
    },
    // 绑定确认与真实目录核验由 E 的可信适配器执行。此入口只接受已经确认的结构。
    acceptBinding(principal, input) {
      return commit(principal, 'acceptBinding', input, (value, project, plan) => {
        const binding = requireLightShape('binding', structuredClone(input.binding));
        permitted(principal, input.projectId, 'confirmBinding', { input, binding });
        if (binding.planKey !== plan.key || binding.projectKey !== project.key || binding.state !== 'confirmed') lightError('STALE_BINDING', '绑定未确认');
        if (value.snapshot.bindings.some(item => item.key === binding.key || item.id === binding.id)) lightError('DUPLICATE_ID', '绑定已存在');
        value.snapshot.bindings.push(binding);
        return { bindingId: binding.id };
      });
    },
    bind(principal, input) {
      return commit(principal, 'bind', input, async (value, project, plan, time) => {
        if (input.action === 'revoke' && input.takeover) lightError('INVALID_INPUT', '撤销不能附带接手意图');
        const steps = input.stepIds.map(id => value.snapshot.steps.find(step => step.id === id && step.planKey === plan.key));
        if (steps.some(step => !step)) lightError('NOT_FOUND', '绑定步骤归属不匹配', 404);
        unique(input.stepIds, '绑定步骤重复');
        let binding = value.snapshot.bindings.find(item => item.id === input.bindingId && item.planKey === plan.key);
        if (input.action === 'propose') {
          permitted(principal, input.projectId, 'proposeBinding', { input, steps });
          if (input.bindingId !== null || input.expectedBindingRevision !== null) lightError('INVALID_INPUT', '新提案身份须为空');
          binding = { key: `${plan.key}/bindings/${randomUUID()}`, id: randomUUID(), projectKey: project.key, planKey: plan.key,
            stepKeys: steps.map(step => step.key), bindingRevision: 1, state: 'proposed', context: structuredClone(input.context),
            confirmationRef: null, revokedAt: null };
          value.snapshot.bindings.push(binding);
          value.metadata.bindingIntents ??= {};
          value.metadata.bindingIntents[binding.key] = { takeover: structuredClone(input.takeover ?? null) };
          value.metadata.bindingOwners ??= {};
          value.metadata.bindingOwners[binding.key] = principal;
          // Date: 2026-11-12. Desktop opt-in allows verified associations without a second user prompt.
          if (!input.takeover && await automaticBinding(principal, structuredClone(binding), structuredClone(input)) === true) {
            binding.state = 'confirmed';
            binding.confirmationRef = `automatic:${principal}`;
          }
        } else {
          if (!binding || binding.bindingRevision !== input.expectedBindingRevision) lightError('STALE_BINDING', '绑定版本不匹配', 409);
          if (digest(binding.stepKeys) !== digest(steps.map(step => step.key)) || digest(binding.context) !== digest(input.context)) lightError('STALE_BINDING', '绑定提案内容已变化', 409);
          if (input.action === 'confirm') {
            if (digest(value.metadata.bindingIntents?.[binding.key]?.takeover ?? null) !== digest(input.takeover ?? null)) lightError('STALE_BINDING', '接手意图与提案不一致', 409);
            permitted(principal, input.projectId, 'confirmBinding', { input, binding, steps });
            if (binding.state !== 'proposed' || await confirmBinding(principal, structuredClone(binding), structuredClone(input)) !== true) lightError('CONFIRMATION_REQUIRED', '需要可信确认及目录分支核验');
            if (input.takeover) {
              permitted(principal, input.projectId, 'takeoverBinding', { input, binding, steps });
              const old = value.snapshot.bindings.find(item => item.id === input.takeover.fromBindingId && item.planKey === plan.key);
              if (!old || old.key === binding.key || !['confirmed', 'revoked'].includes(old.state)
                || old.bindingRevision !== input.takeover.expectedBindingRevision
                || digest([...old.stepKeys].sort()) !== digest([...binding.stepKeys].sort())) lightError('STALE_BINDING', '接手须核对完整旧责任范围和版本', 409);
              const executions = value.snapshot.executions.filter(item => item.bindingKey === old.key && !item.endedAt);
              if (digest(executions.map(item => item.id).sort()) !== digest([...input.takeover.executionIds].sort())) lightError('STALE_EXECUTION', '接手必须覆盖旧绑定全部未结束执行', 409);
              value.metadata.continuations ??= [];
              value.metadata.continuations.push({ eventId: input.eventId, fromBindingKey: old.key, fromBindingId: old.id,
                fromBindingRevision: old.bindingRevision, toBindingKey: binding.key, toBindingId: binding.id,
                executions: structuredClone(executions), receivedAt: time, reason: input.reason });
              old.state = 'revoked'; old.revokedAt ??= time; old.bindingRevision += 1;
              for (const execution of executions) {
                execution.bindingKey = binding.key;
                for (const step of value.snapshot.steps.filter(item => execution.stepKeys.includes(item.key))) step.bindingKey = binding.key;
              }
            }
            binding.state = 'confirmed'; binding.confirmationRef = input.confirmationGrant === null
              ? `automatic:${principal}` : `grant:${digest(input.confirmationGrant)}`;
          } else {
            permitted(principal, input.projectId, 'revokeBinding', { input, binding, steps });
            if (binding.state === 'revoked') lightError('STALE_BINDING', '绑定已撤销', 409);
            binding.state = 'revoked'; binding.revokedAt = time;
          }
          binding.bindingRevision += 1;
        }
        return { bindingId: binding.id, bindingRevision: binding.bindingRevision, state: binding.state };
      }, 'bind');
    },
    async update(principal, input) {
      try { return await commit(principal, 'update', input, async (value, project, plan, time, eventScope) => {
        const snapshot = value.snapshot;
        const step = snapshot.steps.find(item => item.id === input.stepId && item.planKey === plan.key);
        if (!step) lightError('NOT_FOUND', '步骤不属于当前方案', 404);
        const binding = activeBinding(snapshot, step, input);
        // 新写入须匹配认证会话，已提交请求在进入本变更函数前完成幂等回放。
        permitted(principal, input.projectId, 'update', { input, binding, step });
        if (await verifyExecutionContext(principal, structuredClone(binding), structuredClone(step), structuredClone(input)) !== true) {
          lightError('STALE_BINDING', '执行目录或分支已变化，需要重新核对绑定', 409);
        }
        permitted(principal, input.projectId, 'update', { input, binding, step });
        const from = step.status, target = input.targetStatus;
        if (from !== target && !transitions[from].includes(target)) lightError('INVALID_TRANSITION', `${from} -> ${target}`);
        if (['completed', 'cancelled'].includes(from) && ['pending', 'running'].includes(target) && !input.reopen) lightError('REOPEN_REQUIRED', '返工需原因及后继影响');
        let execution = snapshot.executions.find(item => item.id === input.executionId);
        if (execution && (execution.planKey !== plan.key || execution.bindingKey !== binding.key || !execution.stepKeys.includes(step.key))) lightError('STALE_EXECUTION', '执行归属不匹配', 409);
        if (from === 'pending' && target === 'running' || input.reopen && target === 'running') {
          canRun(snapshot, step);
          if (!execution) {
            // executionId 是适配层取得或本服务 reserveExecutionId 生成的身份。
            const reservation = value.metadata.reservedExecutions?.find(item => item.executionId === input.executionId);
            if (!reservation || reservation.principal !== principal || reservation.projectId !== project.id || reservation.planId !== plan.id) {
              lightError('STALE_EXECUTION', '执行身份未登记到当前主体、项目及方案');
            }
            execution = { key: `${plan.key}/executions/${input.executionId}`, id: input.executionId, projectKey: project.key, planKey: plan.key,
              stepKeys: [step.key], bindingKey: binding.key, outcome: 'running', startedAt: time, endedAt: null, handoffConclusion: null };
            snapshot.executions.push(execution);
          }
        }
        if (!execution && !(['pending', 'cancelled'].includes(from) && (from === target || target === 'cancelled' || target === 'pending')))
          lightError('STALE_EXECUTION', '执行不存在');
        if (step.executionKey && !input.reopen && execution?.key !== step.executionKey) lightError('STALE_EXECUTION', '迟到执行需人工核对', 409);
        if (execution?.endedAt && !input.reopen && from !== target) lightError('STALE_EXECUTION', '执行已结束', 409);
        if (target === 'running') {
          if (input.blocker?.resolved) {
            const blocker = step.blockers.find(item => item.blockerId === input.blocker.blockerId);
            if (!blocker || blocker.blockerId.startsWith('supplement:') || digest({ ...blocker, resolved: true }) !== digest(input.blocker)) lightError('INVALID_INPUT', '阻塞解除依据不匹配');
            blocker.resolved = true;
          }
          canRun(snapshot, step);
        }
        if (target === 'blocked') addBlocker(step, input.blocker);
        if (target === 'completed') {
          canRun(snapshot, step, from === target);
          const revisedEvidence = from === target && digest({ checks: step.conditions, evidence: step.evidence }) !== digest({ checks: input.checks, evidence: input.evidence });
          applyChecks(step, input.checks, input.evidence);
          if (childrenOf(snapshot, step.key).some(child => child.required && (child.status !== 'completed' || child.acceptance !== 'passed'))) lightError('DEPENDENCY_NOT_READY', '必要细分未完成', 409);
          step.acceptance = 'passed';
          if (revisedEvidence) invalidateSuccessors(snapshot, step, input.reason, time);
        }
        if (target === 'cancelled') text(input.successorImpact, '取消需后继承接说明');
        if (input.reopen && from !== target || target === 'cancelled' && from !== target) {
          invalidateSuccessors(snapshot, step, input.reopen?.successorImpact ?? input.successorImpact, time);
          step.acceptance = 'pending';
          step.conditions = step.conditions.map(item => ({ ...item, result: 'pending', evidenceIds: [] }));
        }
        step.status = target; step.updatedAt = time; step.sync = 'synced'; step.bindingKey = binding.key;
        if (execution) {
          step.executionKey = execution.key;
          if (input.reopen) { execution.outcome = 'running'; execution.endedAt = null; }
          if (['completed', 'cancelled'].includes(target)) { execution.outcome = target === 'completed' ? 'completedScope' : 'cancelled'; execution.endedAt ??= time; }
        }
        history(value, input, step, from, execution?.key ?? null, time, eventScope);
        return { stepId: step.id, executionId: execution?.id ?? null };
      }, 'update'); } catch (error) {
        // 接手后迟到的新事件只进入历史待核对，不改变实时业务或项目版本。
        if (['STALE_BINDING', 'STALE_EXECUTION', 'REVISION_CONFLICT'].includes(error.code)) await persistence.run(() => {
          const value = load(), old = value.snapshot.bindings.find(item => item.id === input.bindingId);
          const continuation = value.metadata.continuations?.find(item => item.fromBindingId === input.bindingId
            && item.executions.some(execution => execution.id === input.executionId));
          if (!old || !continuation || authorize(principal, input.projectId, 'update', { input, binding: old,
            step: value.snapshot.steps.find(item => item.id === input.stepId) }) !== true) return;
          value.metadata.lateReceipts ??= [];
          const key = digest([principal, input.projectId, input.eventId]);
          if (!value.metadata.lateReceipts.some(item => item.key === key)) {
            value.metadata.lateReceipts.push({ key, eventId: input.eventId, executionId: input.executionId,
              bindingId: input.bindingId, status: 'pendingReview', reason: error.code, input: structuredClone(input), receivedAt: now() });
            persistence.write('light', value);
          }
        });
        throw error;
      }
    },
    reserveExecutionId(principal, input) {
      return commit(principal, 'reserveExecution', input, (value, project, plan) => {
        const executionId = randomUUID();
        value.metadata.reservedExecutions ??= [];
        value.metadata.reservedExecutions.push({ executionId, principal, projectId: project.id, planId: plan.id });
        return { executionId };
      });
    },
    replaceCancelled(principal, input) {
      return commit(principal, 'replaceCancelled', input, (value, project, plan, time) => {
        permitted(principal, input.projectId, 'approveReplacement');
        text(input.approvalRef, '替代必须引用用户批准'); text(input.reason, '替代原因');
        const source = value.snapshot.steps.find(item => item.id === input.sourceStepId && item.planKey === plan.key);
        if (!source || source.status !== 'cancelled' || !input.replacementStepIds?.length) lightError('INVALID_INPUT', '取消来源及替代步骤无效');
        unique(input.replacementStepIds, '替代步骤重复');
        const replacements = input.replacementStepIds.map(id => value.snapshot.steps.find(item => item.id === id && item.planKey === plan.key));
        if (replacements.some(item => !item || item.key === source.key || item.status === 'cancelled')) lightError('INVALID_INPUT', '替代归属不匹配');
        value.history.push({ eventId: input.eventId, previousStep: structuredClone(source), reason: input.reason, receivedAt: time });
        const affected = value.snapshot.steps.filter(item => item.dependsOn.includes(source.key));
        for (const step of affected) step.dependsOn = [...new Set(step.dependsOn.flatMap(key => key === source.key ? replacements.map(item => item.key) : [key]))];
        source.required = false;
        value.metadata[digest(project.key)].replacements.push({ sourceKey: source.key, replacementKeys: replacements.map(item => item.key),
          affectedKeys: affected.map(item => item.key), approvalRef: input.approvalRef, reason: input.reason, receivedAt: time });
        return { sourceStepId: source.id };
      });
    },
    supplement(principal, input) {
      return commit(principal, 'supplement', input, (value, project, plan, time, eventScope) => {
        const snapshot = value.snapshot;
        const step = snapshot.steps.find(item => item.id === input.sourceStepId && item.planKey === plan.key);
        if (!step) lightError('NOT_FOUND', '补充事项来源步骤', 404);
        let item = snapshot.supplements.find(item => item.id === input.supplementId);
        if (input.action === 'create') {
          item = { key: `${plan.key}/supplements/${input.eventId}`, id: randomUUID(), sourceStepKey: step.key, title: input.title, goal: input.goal,
            blocksSource: input.blocksSource, status: 'unconfirmed', linkedPlanKey: null, repairId: input.repairId };
          snapshot.supplements.push(item);
        } else if (!item || item.sourceStepKey !== step.key) lightError('NOT_FOUND', '补充事项不属于来源步骤', 404);
        const from = step.status;
        const linked = snapshot.plans.find(plan => plan.id === input.linkedPlanId);
        if (input.action === 'linkPlan') {
          if (!linked || linked.key === plan.key) lightError('INVALID_INPUT', '关联方案无效');
          const linkedProject = snapshot.projects.find(project => project.key === linked.projectKey);
          permitted(principal, linkedProject.id, 'linkPlan');
          if (item.status !== 'unplanned') lightError('CONFIRMATION_REQUIRED', '规划关联前需用户确认');
          item.linkedPlanKey = linked.key; item.status = 'running';
        }
        if (input.action === 'update') {
          if (['completed', 'cancelled'].includes(item.status) || item.blocksSource !== input.blocksSource || item.repairId !== input.repairId) lightError('INVALID_TRANSITION', '已结束事项或来源阻塞关系不能改写');
          if (item.status !== input.status) {
            if (item.status !== 'unconfirmed' || input.status !== 'unplanned') lightError('INVALID_TRANSITION', '状态变化须确认规划或关联方案');
            permitted(principal, input.projectId, 'confirmSupplement', { input, item, step }); item.status = 'unplanned';
          }
          item.title = input.title; item.goal = input.goal;
        }
        if (input.action === 'resolve') {
          if (item.status !== 'running' || !linked || item.linkedPlanKey !== linked.key || !planProgress(snapshot, linked.key).passed
            || input.evidence.some(proof => proof.result !== 'passed')) lightError('EVIDENCE_MISMATCH', '关联方案尚未满足必要交付');
          const committedEvidence = snapshot.steps.filter(step => step.planKey === linked.key).flatMap(step => step.evidence);
          if (input.evidence.some(proof => !committedEvidence.some(committed => digest(committed) === digest(proof)))) lightError('EVIDENCE_MISMATCH', '结束依据必须引用关联方案的已提交证据');
          item.status = 'completed';
        }
        if (input.action === 'cancel') {
          if (['completed', 'cancelled'].includes(item.status)) lightError('INVALID_TRANSITION', '事项已经结束');
          if (item.blocksSource) permitted(principal, input.projectId, 'approveSupplementCancellation', { input, item, step });
          text(input.reason, '取消需替代承接说明'); item.status = 'cancelled';
        }
        const blockerId = `supplement:${item.id}`;
        if (item.blocksSource && !['completed', 'cancelled'].includes(item.status)) {
          const previous = step.blockers.find(blocker => blocker.blockerId === blockerId);
          if (previous) previous.reason = item.goal;
          else addBlocker(step, { blockerId, reason: item.goal, waitingFor: [item.key], releaseConditions: ['事项结束并核对全部前置'], resolved: false });
          if (['running', 'completed'].includes(step.status)) { step.status = 'blocked'; step.acceptance = 'recheck'; invalidateSuccessors(snapshot, step, input.reason, time); }
        } else if (item.blocksSource) {
          const blocker = step.blockers.find(item => item.blockerId === blockerId); if (blocker) blocker.resolved = true;
          if (step.status === 'blocked' && !step.blockers.some(item => !item.resolved) && !waitingFor(snapshot, step).length) step.status = 'running';
        }
        step.updatedAt = time;
        history(value, input, step, from, step.executionKey, time, eventScope);
        return { supplementId: item.id };
      }, 'supplementWrite');
    },
    completePlan(principal, input) {
      return commit(principal, 'completePlan', input, (value, project, plan) => {
        const holder = { conditions: plan.endConditions, evidence: [] };
        applyChecks(holder, input.checks, input.evidence);
        plan.endConditions = holder.conditions;
        if (!planProgress(value.snapshot, plan.key).passed) lightError('DEPENDENCY_NOT_READY', '必要步骤或方案验收未满足');
        return { planId: plan.id };
      });
    },
    savePreferences(principal, input) {
      return commit(principal, 'preferences', input, (value, project) => {
        const preferences = input.uiPreferences;
        const stepKeys = value.snapshot.steps.filter(item => item.projectKey === project.key).map(item => item.key);
        const routeKeys = value.snapshot.routes.filter(item => item.projectKey === project.key).map(item => item.key);
        const allowedKeys = [...stepKeys, ...routeKeys, ...project.planKeys];
        if (preferences.selectedStepKey && !stepKeys.includes(preferences.selectedStepKey)
          || preferences.focusedRouteKey && !routeKeys.includes(preferences.focusedRouteKey)
          || preferences.collapsedKeys.some(key => !allowedKeys.includes(key))
          || Object.keys(preferences.scrollByProject).some(key => key !== project.key)) lightError('INVALID_INPUT', '阅读定位超出当前项目');
        const current = value.snapshot.uiPreferences;
        value.snapshot.uiPreferences = { ...preferences, collapsedKeys: [...current.collapsedKeys.filter(key => !allowedKeys.includes(key)), ...preferences.collapsedKeys],
          scrollByProject: { ...current.scrollByProject, ...preferences.scrollByProject } };
        return {};
      });
    },
    retainLegacy(principal, input) {
      return commit(principal, 'retainLegacy', input, (value, project) => {
        const original = persistence.read('models')[input.legacyProjectId];
        if (!original) lightError('NOT_FOUND', '旧模型不存在');
        permitted(principal, input.legacyProjectId, 'readLegacy');
        const metadata = value.metadata[digest(project.key)];
        if (metadata.legacy) lightError('HISTORY_REQUIRED', '旧模型出处已保存');
        metadata.legacy = { projectId: input.legacyProjectId, original, sha256: digest(original),
          mapped: original.model.stations.map(station => ({ originalId: station.id, ...legacyLightStatus(station, original.model), occurredAt: null })),
          repairIds: (original.model.business?.repairs ?? []).map(item => item.repairId) };
        return { legacyHash: metadata.legacy.sha256 };
      });
    },
  };
}
