// 日期 2026-11-10。只解析有明确章节和顺序声明的方案，保留 UTF-16 原文位置。
import { createHash } from 'node:crypto';
import { lightError, validateLightSnapshot } from './light-model.mjs';

export function extractLightSteps(text) {
  const headings = [...text.matchAll(/^### 步骤 (\d+) · ([A-Z]-\d+) (.+)\r?$/gm)];
  if (headings.length) {
    if (!/^## 二十个模拟步骤\r?$/m.test(text) || headings.length !== 20
      || new Set(headings.map(item => item[2])).size !== headings.length) lightError('COVERAGE_MISMATCH', '明确二十步骤章节及完整覆盖不匹配');
    return headings.map((match, index) => {
      if (Number(match[1]) !== index + 1) lightError('INVALID_ORDER', match[0]);
      const end = headings[index + 1]?.index ?? text.length;
      const body = text.slice(match.index, end);
      const acceptance = body.match(/^- 验收要求为(.+)。\r?$/m)?.[1];
      if (!acceptance) lightError('INVALID_INPUT', '原文验收要求缺失');
      return { code: match[2], title: match[3], acceptance, locator: `utf16:${match.index}:${end}` };
    });
  }
  const section = text.match(/^## 实施路线与出口\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m);
  if (!section) return null;
  const rows = [...section[1].matchAll(/^\| ([A-Z]) ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|\r?$/gm)];
  if (!rows.length) return null;
  if (new Set(rows.map(item => item[1])).size !== rows.length) lightError('DUPLICATE_ID', '总阶段编号重复');
  return rows.map(match => ({ code: match[1], title: match[2].trim(), acceptance: match[5].trim(), locator: `实施路线与出口/${match[1]}` }));
}

export function prepareLightPlan({ text, sourcePath, version, projectKey, planKey, name, date, context }) {
  const parsed = extractLightSteps(text);
  if (!parsed?.length) lightError('INVALID_INPUT', '未找到完整步骤章节');
  const keyFor = code => `${planKey}/steps/${code}`;
  const dependencyRows = [...text.matchAll(/^\| ([A-Z]-\d+(?:、[A-Z]-\d+)*) \| ([^|]+) \|\r?$/gm)];
  const dependencies = new Map();
  for (const match of dependencyRows) for (const code of match[1].split('、')) {
    dependencies.set(code, match[2].trim() === '无' ? [] : match[2].trim().split('、'));
  }
  const stageRows = [...text.matchAll(/^\| ([A-Z]) [^|]+ \| ([^|]+) \| [^|]+ \| [^|]+ \|\r?$/gm)];
  for (const match of stageRows) dependencies.set(match[1], match[2].trim().match(/^[A-Z](?:、[A-Z])*$/)?.[0].split('、') ?? []);
  const timestamp = `${date}T00:00:00+08:00`;
  const steps = parsed.map((item, index) => ({ key: keyFor(item.code), id: null, projectKey, planKey, parentKey: null,
    code: item.code, originalCode: item.code, sourceLocator: item.locator, title: item.title, order: index + 1, required: true,
    dependsOn: (dependencies.get(item.code) ?? []).map(keyFor), status: 'pending', acceptance: 'pending', sync: 'pendingSync',
    conditions: [{ conditionId: `${keyFor(item.code)}/exit`, text: item.acceptance, required: true, result: 'pending', evidenceIds: [] }],
    evidence: [], blockers: [], executionKey: null, bindingKey: null, updatedAt: timestamp }));
  const routeRows = [...text.matchAll(/^\| (分支[^|]+) \| [^|]+ \| `([^`]+)` \| `([^`]+)` \| ([^|]+) \|\r?$/gm)];
  const routes = routeRows.map((match, index) => ({ key: `${planKey}/routes/${index + 1}`, id: null, projectKey, planKey,
    label: match[1].trim(), stepKeys: match[4].trim().split(' → ').map(keyFor), order: index + 1,
    context: { ...context, worktreeOrdinal: index + 1, worktreePath: match[3], branch: match[2] }, sourceStepKey: null, returnStepKey: null }));
  if (!routes.length) routes.push({ key: `${planKey}/routes/1`, id: null, projectKey, planKey, label: name,
    stepKeys: steps.map(item => item.key), order: 1, context, sourceStepKey: null, returnStepKey: null });
  return validateLightSnapshot({ schemaVersion: 'light-1.0', date, mode: 'local', revision: null, generatedAt: timestamp,
    projects: [{ key: projectKey, id: null, name, planKeys: [planKey], revision: null }],
    plans: [{ key: planKey, id: null, projectKey, name, stageCount: steps.length, stageKeys: steps.map(item => item.key),
      source: { path: sourcePath, version, sha256: createHash('sha256').update(text).digest('hex'), locator: '完整步骤及依赖表', trust: 'declared' }, endConditions: [] }],
    steps, routes, bindings: [], executions: [], supplements: [], events: [],
    uiPreferences: { collapsedKeys: [], selectedStepKey: null, focusedRouteKey: null, scrollByProject: {} } });
}

// 旧原始状态与派生待核验分开映射。历史原样存入 metadata，未知时间保持 null。
export function legacyLightStatus(station, model = {}) {
  const raw = station.report?.status ?? station.status;
  if (raw === 'done') return { status: 'running', acceptance: 'pending' };
  const started = model.lifecycle?.starts?.some(item => item.stationId === station.id)
    || model.business?.executions?.some(item => item.stationId === station.id);
  return { status: ({ todo: 'pending', active: 'running', blocked: 'blocked', cancelled: 'cancelled' })[raw] ?? (started ? 'running' : 'pending'), acceptance: 'pending' };
}
