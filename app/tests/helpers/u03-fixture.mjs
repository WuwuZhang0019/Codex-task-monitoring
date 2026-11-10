import { sourceHash } from '../../server/import-drafts.mjs';

export function draftInput(count = 8) {
  const condition = (conditionId, originalText) => ({ conditionId, originalText, method: '核对隔离命令及产物', required: true, evidenceTypes: ['command'], reviewRole: 'authorizedReviewer' });
  const candidate = { goal: '完成固定业务路线', initialGoal: '完成固定业务路线', endCondition: '全部需求与项目验收通过', version: '1.0', date: '2026-11-10', chapter: '完整方案步骤', sourcePath: null, previousPlanId: null, declaredStepCount: count,
    folders: [{ folderId: 'folder', name: '本地固定样例容器', externalProjectId: null }],
    tasks: [{ taskId: 'task', folderId: 'folder', name: '业务路线', initialGoal: '完成全部固定站点', goal: '完成全部固定站点', endCondition: '任务全部条件通过', acceptance: [condition('task-k', '任务全部条件通过')] }],
    stations: Array.from({ length: count }, (_, i) => ({ stationId: `s${i + 1}`, taskId: 'task', code: `U${String(i + 1).padStart(2, '0')}`, title: `固定站点${i + 1}`, goal: `完成本站${i + 1}`, scope: `限定本站${i + 1}业务`, delivery: [`本站${i + 1}产物`],
      dependsOn: [], successors: [], acceptance: [condition(`k${i + 1}`, `本站${i + 1}检查通过`)], endCondition: `本站${i + 1}检查通过`, sourceLocator: `完整方案步骤/${i + 1}`, parentStationId: null })),
    acceptance: [condition('project-k', '项目全部需求验收通过')], provenance: [], candidates: [{ candidateId: 'optional', title: '额外优化', reason: '本期外范围', status: 'paused', sourceLocator: '暂停事项' }],
    requirements: Array.from({ length: count }, (_, i) => ({ requirementId: `req${i + 1}`, originalText: `要求本站${i + 1}完整交付`, stationIds: [`s${i + 1}`], conditionIds: [`k${i + 1}`] })) };
  const originalText = `# 固定隔离业务样例\n日期：2026-11-10\n状态：固定验证输入\n\n## 业务声明\n${JSON.stringify(candidate, null, 2)}\n\n## 完整方案步骤\n${candidate.stations.map((s, i) => `${i + 1}. ${s.code}：${s.title}`).join('\n')}\n\n## 暂停事项\n额外优化仅独立候选\n`;
  function provenance(value, path = '') {
    function add(excerpt) { const start = originalText.indexOf(excerpt); candidate.provenance.push({fieldPath:path,origin:'source',locator:'业务声明',excerpt,startUtf16:start,endUtf16:start+excerpt.length}); }
    if (Array.isArray(value)) { add('业务声明'); value.forEach((v,i)=>provenance(v,`${path}/${i}`)); }
    else if (value && typeof value==='object') for(const [key,v] of Object.entries(value)){if(key!=='provenance')provenance(v,`${path}/${key}`);}
    else add(typeof value==='string'&&originalText.includes(value)&&value?value:'业务声明');
  }
  provenance(candidate);
  return { name: 'U03 固定隔离样例', expectedRevision: 0, idempotencyKey: 'fixture-draft', source: { sourceId: null, locator: '固定样例输入', sourceHash: sourceHash(originalText), originalText, recordedAt: '2026-11-10T03:30:00Z', origin: 'manual' }, candidate };
}

export const workContext = { sourceId:null, executionId:null, verification:'declared', repositoryId: 'fixed-repo', repositoryRoot: 'G:\\isolated', worktreePath: 'G:\\isolated', branchName: 'main', headCommit: '1'.repeat(40), detachedHead: false, dirty: false, contentFingerprint: null, observedAt: '2026-11-10T03:30:00Z' };
export const actorDeclaration = {hostId:null,dataRootId:null,provider:null,sessionId:null,threadId:null,parentSessionId:null,turnId:null,missingReasons:['固定隔离样例声明']};
