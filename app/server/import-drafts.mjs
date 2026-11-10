import { randomUUID, createHash } from 'node:crypto';
import { requireShape } from './business-schema.mjs';
import { digest } from './receipts.mjs';
import { validateRelationships, assertModelHistory } from './relationships.mjs';
import { HttpError, projectInput, exactKeys } from './validation.mjs';
import { planSteps } from './plan-steps.mjs';

export const sourceHash = text => createHash('sha256').update(text, 'utf8').digest('hex');
const present = value => typeof value === 'string' && !!value.trim();
const requiredText = (conditions, endCondition) => [...new Set([...conditions.filter(c => c.required).map(c => c.originalText), ...(endCondition ? [endCondition] : [])])];

export function draftIssues(draft, previous, previousRevision = 0) {
  const { candidate: c, source } = draft;
  const issues = [];
  function issue(path, message, blocking = true) { issues.push({ code: digest([path, message]).slice(0, 16), path, message, blocking }); }
  const provenance = new Map(c.provenance.map(p => [p.fieldPath, p]));
  function required(path, value) {
    if (!present(value)) issue(path, '缺少必需内容，请集中补齐');
    if (!provenance.has(path)) issue(path, '缺少原文出处或用户修订依据');
  }
  if (sourceHash(source.originalText) !== source.sourceHash.toLowerCase()) issue('/source/sourceHash', '原文 SHA256 不匹配');
  for (const p of c.provenance) {
    let value = c;
    for (const key of p.fieldPath.split('/').slice(1)) value = value?.[key];
    if (value === undefined) issue(p.fieldPath, '出处引用的字段不存在');
    if (p.origin === 'source' && (!Number.isInteger(p.startUtf16) || !Number.isInteger(p.endUtf16) || p.endUtf16 <= p.startUtf16 || source.originalText.slice(p.startUtf16, p.endUtf16) !== p.excerpt)) issue(p.fieldPath, '摘录与原文 UTF-16 位置不一致');
    if (p.origin === 'systemId' && !/Id$|Ids\/\d+$/.test(p.fieldPath)) issue(p.fieldPath, '系统 ID 出处不能代替业务字段出处');
  }
  for (const key of ['goal', 'initialGoal', 'endCondition', 'version', 'date', 'chapter']) required(`/${key}`, c[key]);
  const conditionIds = new Set();
  function conditions(path, list) {
    if (!list.some(x => x.required)) issue(path, '至少需要一项必需验收条件');
    for (const [i, item] of list.entries()) {
      if (conditionIds.has(item.conditionId)) issue(`${path}/${i}`, '验收条件 ID 重复');
      conditionIds.add(item.conditionId);
      required(`${path}/${i}/originalText`, item.originalText);
      if (!item.evidenceTypes.length) issue(`${path}/${i}`, '缺少允许证据类型');
    }
  }
  conditions('/acceptance', c.acceptance);
  if (!c.folders.length || !c.tasks.length || !c.stations.length) issue('/', '必须包含文件夹、任务线和站点');
  for (const [i, folder] of c.folders.entries()) required(`/folders/${i}/name`, folder.name);
  for (const [i, task] of c.tasks.entries()) {
    for (const key of ['name', 'initialGoal', 'goal', 'endCondition']) required(`/tasks/${i}/${key}`, task[key]);
    if (!task.folderId) issue(`/tasks/${i}/folderId`, '任务唯一文件夹待确认');
    if (!c.stations.some(s => s.taskId === task.taskId)) issue(`/tasks/${i}`, '任务线没有站点');
    conditions(`/tasks/${i}/acceptance`, task.acceptance);
  }
  for (const [i, station] of c.stations.entries()) {
    for (const key of ['code', 'title', 'goal', 'scope', 'endCondition']) required(`/stations/${i}/${key}`, station[key]);
    if (!station.delivery.length) issue(`/stations/${i}/delivery`, '缺少交付物');
    if (!provenance.has(`/stations/${i}/dependsOn`)) issue(`/stations/${i}/dependsOn`, '全部依赖需要出处或用户确认');
    conditions(`/stations/${i}/acceptance`, station.acceptance);
    const reverse = c.stations.filter(s => s.dependsOn.includes(station.stationId)).map(s => s.stationId).sort();
    if (digest(reverse) !== digest([...station.successors].sort())) issue(`/stations/${i}/successors`, '依赖与后继不一致');
    if (station.parentStationId !== null) issue(`/stations/${i}/parentStationId`, '站内细化应由细化记录保存，不得增加主路线站数');
  }
  const steps = planSteps({ source: source.originalText });
  if (!steps || steps.length !== c.declaredStepCount || steps.length !== c.stations.length || steps.some((s, i) => s.code !== c.stations[i]?.code || s.title !== c.stations[i]?.title)) issue('/declaredStepCount', '完整路线声明与原文编号、顺序、标题或总数不一致，请保留完整方案步骤章节');
  if (!c.requirements.length) issue('/requirements', '原始需求清单待确认');
  const requirements = new Set();
  for (const [i, requirement] of c.requirements.entries()) {
    if (requirements.has(requirement.requirementId)) issue(`/requirements/${i}`, '需求 ID 重复');
    requirements.add(requirement.requirementId);
    required(`/requirements/${i}/originalText`, requirement.originalText);
    if (!requirement.stationIds.length || !requirement.conditionIds.length || requirement.stationIds.some(id => !c.stations.some(s => s.stationId === id)) || requirement.conditionIds.some(id => !c.stations.filter(s => requirement.stationIds.includes(s.stationId)).some(s => s.acceptance.some(a => a.conditionId === id)))) issue(`/requirements/${i}`, '需求未覆盖或站点与条件映射不一致');
  }
  try { const model = validateRelationships(materialize(draft, previous)); if (previousRevision > 0) assertModelHistory(previous, model); } catch (error) { issue('/candidate', error.message); }
  try { projectInput(projectFromDraft(draft)); } catch (error) { issue('/project', error.message); }
  issue('/bindings', '聊天来源待绑定，发布后按 U04 确认真实来源', false);
  return issues;
}

export function materialize(draft, previous) {
  const c = draft.candidate;
  const id = key => draft.entityIds[key];
  const planId = draft.planId;
  const plan = { id: planId, goal: c.goal, initialGoal: c.initialGoal, version: c.version, date: c.date, chapter: c.chapter,
    source: draft.source.originalText, sourceHash: draft.source.sourceHash, sourcePath: c.sourcePath, sourceLocator: draft.source.locator,
    provenance: c.provenance, endCondition: c.endCondition, acceptance: requiredText(c.acceptance, c.endCondition), conditions: c.acceptance, previousId: c.previousPlanId,
    routeDeclaration: { count: c.declaredStepCount, stationIds: c.stations.map(s => id(s.stationId)), sourceHash: draft.source.sourceHash } };
  return { ...previous, folders: c.folders.map(f => ({ ...previous?.folders.find(x => x.id === id(f.folderId)), id: id(f.folderId), name: f.name, externalId: f.externalProjectId })),
    tasks: c.tasks.map(t => ({ ...previous?.tasks.find(x => x.id === id(t.taskId)), id: id(t.taskId), folderId: id(t.folderId), name: t.name, goal: t.goal, initialGoal: t.initialGoal, acceptance: requiredText(t.acceptance, t.endCondition), conditions: t.acceptance, endCondition: t.endCondition })),
    stations: c.stations.map(s => ({ ...previous?.stations.find(x => x.id === id(s.stationId)), ...s, id: id(s.stationId), taskId: id(s.taskId), planId, chapter: c.chapter, acceptance: requiredText(s.acceptance, s.endCondition), conditions: s.acceptance, dependsOn: s.dependsOn.map(id), successors: s.successors.map(id), verification: 'pending' })),
    chats: previous?.chats ?? [], plans: [...(previous?.plans ?? []), plan], initialPlanId: previous?.initialPlanId ?? planId, currentPlanId: planId,
    acceptance: requiredText(c.acceptance, c.endCondition), requirements: c.requirements.map(r => ({ ...r, stationIds: r.stationIds.map(id) })),
    initialRequirements: previous?.initialRequirements ?? c.requirements.map(r => ({ ...r, stationIds: r.stationIds.map(id) })),
    candidates: c.candidates.map(x => ({ id: id(x.candidateId), ...x, date: c.date })), schemaVersion: '1.0.0' };
}

export function projectFromDraft(draft) {
  const c = draft.candidate;
  return { name: draft.name, goal: c.goal ?? '', source: draft.source.originalText,
    steps: c.stations.map(s => ({ id: draft.entityIds[s.stationId], title: s.title, purpose: s.scope, line: c.tasks.find(t => t.taskId === s.taskId)?.name ?? '',
      sourceExcerpt: s.sourceLocator, dependsOn: s.dependsOn.map(id => draft.entityIds[id]), acceptance: requiredText(s.acceptance, s.endCondition), status: 'todo', summary: '', nextAction: '', blocker: '', evidence: '' })) };
}

export function createDrafts(persistence, requests, models) {
  function get(id) {
    const all = persistence.read('drafts');
    const draft = Object.hasOwn(all, id) ? all[id] : null;
    if (!draft) throw new HttpError(404, '草稿不存在');
    return draft;
  }
  function put(input, principal = 'local-ui') {
    exactKeys(input, ['draftId', 'name', 'source', 'candidate', 'targetProjectId', 'expectedRevision', 'idempotencyKey'], 'draft');
    requireShape('source', input.source);
    requireShape('planCandidate', input.candidate);
    if (!present(input.name)) throw new HttpError(400, '项目名称必须填写');
    return requests.execute(principal, input.targetProjectId ?? 'new', 'draft.put', input, async () => {
      const old = input.draftId ? get(input.draftId) : null;
      if (old?.status === 'committed') throw new HttpError(409, '已发布草稿不可覆盖，请建立新版本草稿');
      if (input.expectedRevision !== (old?.revision ?? 0)) throw new HttpError(409, '草稿 revision 冲突');
      if (old && (old.targetProjectId !== (input.targetProjectId ?? null) || old.principal !== principal)) throw new HttpError(403, '草稿目标或主体不匹配');
      const current = input.targetProjectId ? await models.get(input.targetProjectId) : null;
      const entityIds = Object.assign(Object.create(null), old?.entityIds);
      const ids = [...input.candidate.folders.map(x => x.folderId), ...input.candidate.tasks.map(x => x.taskId), ...input.candidate.stations.map(x => x.stationId), ...input.candidate.candidates.map(x => x.candidateId)];
      if (new Set(ids).size !== ids.length) throw new HttpError(400, '候选实体 ID 必须全局唯一');
      for (const key of ids) entityIds[key] ??= current && ['folders', 'tasks', 'stations', 'candidates'].some(group => current.model[group]?.some(x => x.id === key)) ? key : randomUUID();
      const draft = { draftId: old?.draftId ?? randomUUID(), planId: old?.planId ?? randomUUID(), projectId: old?.projectId ?? input.targetProjectId ?? randomUUID(),
        targetProjectId: input.targetProjectId ?? null, principal, name: input.name, schemaVersion: '1.0.0', revision: (old?.revision ?? 0) + 1,
        source: input.source, candidate: input.candidate, entityIds, status: 'draft', issues: [], history: [...(old?.history ?? []), ...(old ? [{ revision: old.revision, source: old.source, candidate: old.candidate }] : [])], updatedAt: new Date().toISOString() };
      draft.issues = draftIssues(draft, current?.model, current?.revision);
      draft.status = draft.issues.some(x => x.blocking) ? 'needs-review' : 'ready';
      persistence.write('drafts', { ...persistence.read('drafts'), [draft.draftId]: draft });
      return draft;
    });
  }
  return { get, put, list: () => Object.values(persistence.read('drafts')) };
}
