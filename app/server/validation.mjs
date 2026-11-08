// Shared wire contract. Lengths are UTF-16 code units; no coercion or silent truncation.
export const LIMITS = Object.freeze({ name: 200, goal: 10000, source: 500000,
  steps: 60, id: 120, title: 300, line: 200, purpose: 10000,
  sourceExcerpt: 20000, acceptance: 30, acceptanceItem: 2000,
  summary: 20000, nextAction: 10000, blocker: 10000, evidence: 20000 });
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function object(value, label = 'body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `${label} 必须是对象`);
  return value;
}
export function exactKeys(value, keys, label) {
  object(value, label);
  const unexpected = Object.keys(value).find(key => !keys.includes(key));
  if (unexpected) throw new HttpError(400, `${label} 不支持字段 ${unexpected}`);
}
export function text(value, label, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new HttpError(400, `${label} 必须是${required ? '非空' : ''}字符串，最多 ${max} 字符`);
  }
  return value;
}
const STEP_KEYS = ['id', 'title', 'line', 'purpose', 'sourceExcerpt', 'dependsOn', 'acceptance', 'status', 'summary', 'nextAction', 'blocker', 'evidence'];
export function validateSteps(steps) {
  if (!Array.isArray(steps) || steps.length > LIMITS.steps) throw new HttpError(400, 'steps 必须是数组且最多 60 站');
  const ids = new Set();
  for (const [i, step] of steps.entries()) {
    const label = `steps[${i}]`;
    exactKeys(step, STEP_KEYS, label);
    for (const key of ['id', 'title', 'line', 'purpose', 'sourceExcerpt', 'summary', 'nextAction', 'blocker', 'evidence']) {
      text(step[key], `${label}.${key}`, LIMITS[key], key === 'id' || key === 'title');
    }
    if (ids.has(step.id)) throw new HttpError(400, `步骤 ID 重复: ${step.id}`);
    ids.add(step.id);
    if (!['todo', 'active', 'blocked', 'done'].includes(step.status)) throw new HttpError(400, `${label}.status 非法`);
    if (!Array.isArray(step.acceptance) || step.acceptance.length < 1 || step.acceptance.length > LIMITS.acceptance) {
      throw new HttpError(400, `${label}.acceptance 至少 1 项且最多 ${LIMITS.acceptance} 项`);
    }
    step.acceptance.forEach(item => text(item, `${label}.acceptance`, LIMITS.acceptanceItem, true));
    if (!Array.isArray(step.dependsOn) || step.dependsOn.length > LIMITS.steps) throw new HttpError(400, `${label}.dependsOn 非法`);
    const seen = new Set();
    for (const dep of step.dependsOn) {
      text(dep, `${label}.dependsOn`, LIMITS.id, true);
      if (dep === step.id || seen.has(dep)) throw new HttpError(400, `${label} 依赖包含自环或重复`);
      seen.add(dep);
    }
  }
  const map = new Map(steps.map(step => [step.id, step]));
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new HttpError(400, '步骤依赖存在环');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of map.get(id).dependsOn) {
      if (!ids.has(dep)) throw new HttpError(400, `缺失依赖: ${dep}`);
      visit(dep);
    }
    visiting.delete(id); visited.add(id);
  }
  for (const id of ids) visit(id);
  return structuredClone(steps);
}
export function projectInput(body, update = false) {
  exactKeys(body, update ? ['revision', 'name', 'goal', 'source', 'steps'] : ['name', 'goal', 'source', 'steps'], 'project');
  if (update && (!Number.isSafeInteger(body.revision) || body.revision < 1 || body.revision >= Number.MAX_SAFE_INTEGER)) {
    throw new HttpError(400, 'revision 必须是正安全整数');
  }
  const result = {
    name: text(body.name, 'name', LIMITS.name, true),
    goal: text(update ? body.goal : (body.goal ?? ''), 'goal', LIMITS.goal),
    source: text(update ? body.source : (body.source ?? ''), 'source', LIMITS.source),
    steps: validateSteps(update ? body.steps : (body.steps ?? [])),
  };
  // Optional means absent, not null.
  for (const key of ['goal', 'source', 'steps']) if (body[key] === null) throw new HttpError(400, `${key} 不允许 null`);
  return result;
}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateDatabase(data) {
  exactKeys(data, ['version', 'projects'], 'database');
  if (data.version !== 1 || !Array.isArray(data.projects)) throw new Error('不支持的数据版本或 projects 非数组');
  const ids = new Set();
  for (const project of data.projects) {
    exactKeys(project, ['id', 'name', 'goal', 'source', 'steps', 'revision', 'createdAt', 'updatedAt'], 'stored project');
    if (!UUID.test(project.id) || ids.has(project.id)) throw new Error('项目 UUID 非法或重复');
    ids.add(project.id);
    projectInput({ name: project.name, goal: project.goal, source: project.source, steps: project.steps, revision: project.revision }, true);
    for (const key of ['createdAt', 'updatedAt']) {
      if (typeof project[key] !== 'string' || !Number.isFinite(Date.parse(project[key]))) throw new Error(`${key} 非法`);
    }
  }
  return data;
}
