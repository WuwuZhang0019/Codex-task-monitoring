// 日期 2026-11-10。轻量路线模型共用冻结契约及已有聚合事务。
import Ajv2020 from 'ajv/dist/2020.js';
import contract from '../mcp/contracts/light-v1.json' with { type: 'json' };
import { HttpError } from './validation.mjs';

const schema = structuredClone(contract);
for (const key of Object.keys(schema).filter(key => key.startsWith('x-'))) delete schema[key];
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false });
ajv.addSchema(schema);
export const transitions = contract['x-transitions'];
export function lightError(code, message, status = 400) {
  const error = new HttpError(status, `${code}: ${message}`);
  error.code = code;
  throw error;
}
export function requireLightShape(name, value) {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  if (!validate(value)) lightError('INVALID_INPUT', JSON.stringify(validate.errors));
  return value;
}
export function unique(values, label) {
  if (new Set(values).size !== values.length) lightError('DUPLICATE_ID', label);
}
export function requiredConditions(conditions, evidence) {
  const proofs = new Map(evidence.map(item => [item.evidenceId, item]));
  return conditions.filter(item => item.required).every(item => item.result === 'passed'
    && item.evidenceIds.length > 0 && item.evidenceIds.every(id => proofs.get(id)?.result === 'passed'));
}
export function childrenOf(snapshot, key) { return snapshot.steps.filter(step => step.parentKey === key); }
export function dependenciesOf(snapshot, step) {
  const parent = snapshot.steps.find(item => item.key === step.parentKey);
  return [...new Set([...step.dependsOn, ...(parent?.dependsOn ?? [])])];
}
export function waitingFor(snapshot, step) {
  return dependenciesOf(snapshot, step).filter(key => {
    const dependency = snapshot.steps.find(item => item.key === key);
    return dependency?.status !== 'completed' || dependency.acceptance !== 'passed';
  });
}
export function stepPassed(snapshot, step) {
  return step.status === 'completed' && step.acceptance === 'passed'
    && requiredConditions(step.conditions, step.evidence) && !step.blockers.some(item => !item.resolved)
    && childrenOf(snapshot, step.key).filter(item => item.required).every(child => stepPassed(snapshot, child));
}
export function planProgress(snapshot, planKey) {
  const plan = snapshot.plans.find(item => item.key === planKey);
  const steps = snapshot.steps.filter(item => item.planKey === planKey && item.required);
  const evidence = snapshot.steps.filter(item => item.planKey === planKey).flatMap(item => item.evidence);
  return { completed: steps.filter(step => stepPassed(snapshot, step)).length, total: steps.length,
    passed: steps.length > 0 && steps.every(step => stepPassed(snapshot, step))
      && requiredConditions(plan.endConditions, evidence)
      && !snapshot.supplements.some(item => item.blocksSource && !['completed', 'cancelled'].includes(item.status)
        && snapshot.steps.find(step => step.key === item.sourceStepKey)?.planKey === planKey) };
}

export function validateLightSnapshot(snapshot) {
  requireLightShape('snapshot', snapshot);
  const groups = ['projects', 'plans', 'steps', 'routes', 'bindings', 'executions', 'supplements'];
  const records = groups.flatMap(group => snapshot[group]);
  unique(records.map(item => item.key), '跨实体 key 重复');
  unique(records.map(item => item.id).filter(Boolean), '服务 id 重复');
  if (snapshot.mode === 'local' && (snapshot.revision !== null || records.some(item => item.id !== null))) {
    lightError('INVALID_IDENTITY', '本地候选的服务身份必须为空');
  }
  if (snapshot.mode === 'service' && records.some(item => !item.id)) lightError('INVALID_IDENTITY', '服务实体缺少真实登记身份');
  const projects = new Map(snapshot.projects.map(item => [item.key, item]));
  const plans = new Map(snapshot.plans.map(item => [item.key, item]));
  const steps = new Map(snapshot.steps.map(item => [item.key, item]));
  const samePlan = (key, planKey) => {
    if (steps.get(key)?.planKey !== planKey) lightError('MISSING_REFERENCE', `步骤 ${key}`);
  };
  for (const project of snapshot.projects) {
    unique(project.planKeys, '项目方案重复');
    if (snapshot.mode === 'service' && !Number.isSafeInteger(project.revision)) lightError('INVALID_REVISION', project.key);
    for (const key of project.planKeys) if (plans.get(key)?.projectKey !== project.key) lightError('MISSING_REFERENCE', key);
  }
  for (const plan of snapshot.plans) {
    if (!projects.get(plan.projectKey)?.planKeys.includes(plan.key)) lightError('MISSING_REFERENCE', plan.key);
    const stages = snapshot.steps.filter(item => item.planKey === plan.key && item.parentKey === null).sort((a, b) => a.order - b.order);
    if (JSON.stringify(stages.map(item => item.key)) !== JSON.stringify(plan.stageKeys) || stages.length !== plan.stageCount) {
      lightError('COVERAGE_MISMATCH', plan.key);
    }
    unique(plan.endConditions.map(item => item.conditionId), '方案验收重复');
  }
  const codes = [], orders = [];
  for (const step of snapshot.steps) {
    if (plans.get(step.planKey)?.projectKey !== step.projectKey) lightError('MISSING_REFERENCE', step.key);
    const scope = `${step.planKey}/${step.parentKey ?? ''}`;
    codes.push(`${scope}/${step.code}`); orders.push(`${scope}/${step.order}`);
    if (step.parentKey !== null) {
      const parent = steps.get(step.parentKey);
      if (!parent || parent.parentKey !== null || parent.planKey !== step.planKey || !step.code.startsWith(parent.code + '-')) {
        lightError('INVALID_PARENT', step.key);
      }
    }
    unique(step.dependsOn, '重复前置');
    unique(step.conditions.map(item => item.conditionId), '重复验收条件');
    unique(step.evidence.map(item => item.evidenceId), '重复证据');
    unique(step.blockers.map(item => item.blockerId), '重复阻塞');
    for (const key of step.dependsOn) samePlan(key, step.planKey);
    if (step.executionKey && !snapshot.executions.some(item => item.key === step.executionKey && item.planKey === step.planKey && item.stepKeys.includes(step.key))) lightError('MISSING_REFERENCE', '步骤执行');
    if (step.bindingKey && !snapshot.bindings.some(item => item.key === step.bindingKey && item.planKey === step.planKey)) lightError('MISSING_REFERENCE', '步骤绑定');
    if (step.status === 'completed' && !stepPassed(snapshot, step)) lightError('EVIDENCE_MISMATCH', step.key);
  }
  unique(codes, '作用域内编号重复'); unique(orders, '作用域内顺序重复');
  const active = new Set(), visited = new Set();
  function visit(key) {
    if (active.has(key)) lightError('DEPENDENCY_CYCLE', key);
    if (visited.has(key)) return;
    active.add(key);
    const step = steps.get(key);
    for (const next of [...step.dependsOn, ...childrenOf(snapshot, key).filter(item => item.required).map(item => item.key)]) visit(next);
    active.delete(key); visited.add(key);
  }
  for (const key of steps.keys()) visit(key);
  for (const route of snapshot.routes) {
    if (plans.get(route.planKey)?.projectKey !== route.projectKey) lightError('MISSING_REFERENCE', route.key);
    unique(route.stepKeys, '路线步骤重复');
    for (const key of [...route.stepKeys, route.sourceStepKey, route.returnStepKey].filter(Boolean)) samePlan(key, route.planKey);
    const ordered = route.stepKeys.map(key => steps.get(key).order);
    if (ordered.some((value, index) => index > 0 && value <= ordered[index - 1])) lightError('INVALID_ORDER', route.key);
  }
  for (const plan of snapshot.plans) {
    const covered = snapshot.routes.filter(item => item.planKey === plan.key).flatMap(item => item.stepKeys);
    unique(covered, '步骤被多条路线重复覆盖');
    if (snapshot.steps.some(step => step.planKey === plan.key && !covered.includes(step.key) && !covered.includes(step.parentKey))) lightError('COVERAGE_MISMATCH', '路线遗漏步骤');
  }
  const owners = new Set();
  for (const binding of snapshot.bindings) {
    if (plans.get(binding.planKey)?.projectKey !== binding.projectKey) lightError('MISSING_REFERENCE', binding.key);
    unique(binding.stepKeys, '绑定步骤重复');
    for (const key of binding.stepKeys) samePlan(key, binding.planKey);
    if (binding.state === 'confirmed') {
      if (!binding.id || !binding.bindingRevision || !binding.confirmationRef || binding.revokedAt) lightError('STALE_BINDING', binding.key);
      const owned = snapshot.steps.filter(step => binding.stepKeys.includes(step.key) || binding.stepKeys.includes(step.parentKey));
      for (const step of owned) {
        if (owners.has(step.key)) lightError('DUPLICATE_OWNER', step.key);
        owners.add(step.key);
      }
    }
  }
  for (const execution of snapshot.executions) {
    if (plans.get(execution.planKey)?.projectKey !== execution.projectKey) lightError('MISSING_REFERENCE', execution.key);
    for (const key of execution.stepKeys) samePlan(key, execution.planKey);
    if (execution.bindingKey && !snapshot.bindings.some(item => item.key === execution.bindingKey && item.planKey === execution.planKey)) lightError('MISSING_REFERENCE', execution.key);
  }
  for (const item of snapshot.supplements) {
    if (!steps.has(item.sourceStepKey) || (item.linkedPlanKey && !plans.has(item.linkedPlanKey))) lightError('MISSING_REFERENCE', item.key);
  }
  unique(snapshot.events.map(item => item.eventId), '重复历史事件');
  for (const event of snapshot.events) {
    if (event.stepKey && !steps.has(event.stepKey)) lightError('MISSING_REFERENCE', event.eventId);
    if (event.executionKey && !snapshot.executions.some(item => item.key === event.executionKey)) lightError('MISSING_REFERENCE', event.eventId);
  }
  return snapshot;
}

export function validateLightStorage(value) {
  if (value === undefined) return;
  if (value.version !== 1 || !value.metadata || !Array.isArray(value.history)) lightError('INVALID_STORAGE', '轻量数据版本或历史损坏');
  validateLightSnapshot(value.snapshot);
}
