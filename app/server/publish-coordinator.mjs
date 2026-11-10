import { randomUUID } from 'node:crypto';
import { digest } from './receipts.mjs';
import { draftIssues, materialize, projectFromDraft } from './import-drafts.mjs';
import { HttpError } from './validation.mjs';

export function createPublisher(persistence, requests, drafts, projects, models) {
  async function basis(draft) {
    if (!draft.targetProjectId) return { revision: 0, model: null, projectRevision: 0 };
    const value = await models.get(draft.targetProjectId);
    return { ...value, projectRevision: projects.get(draft.targetProjectId).revision };
  }
  function diff(draft, old) {
    return { initialGoal: old.model?.plans.find(p => p.id === old.model.initialPlanId)?.initialGoal ?? old.model?.plans.find(p => p.id === old.model.initialPlanId)?.goal ?? draft.candidate.initialGoal,
      previousGoal: old.model?.plans.find(p => p.id === old.model.currentPlanId)?.goal ?? null, currentGoal: draft.candidate.goal,
      previousPlanId: old.model?.currentPlanId ?? null, nextPlanId: draft.planId,
      before: old.model && { tasks: old.model.tasks, stations: old.model.stations, acceptance: old.model.acceptance, requirements: old.model.requirements },
      after: { tasks: draft.candidate.tasks, stations: draft.candidate.stations, acceptance: draft.candidate.acceptance, requirements: draft.candidate.requirements },
      uncovered: draftIssues(draft, old.model, old.revision).filter(x => x.path.startsWith('/requirements')) };
  }
  return {
    validate: id => persistence.run(async () => {
      const draft = drafts.get(id), old = await basis(draft);
      return { draftId: id, revision: draft.revision, basisRevision: old.revision, issues: draftIssues(draft, old.model, old.revision), diff: diff(draft, old) };
    }),
    confirm: (id, input, principal = 'local-ui') => persistence.run(async () => {
      const draft = drafts.get(id), old = await basis(draft);
      if (draft.principal !== principal || input.revision !== draft.revision || input.expectedRevision !== old.revision) throw new HttpError(409, '确认版本冲突');
      if (input.acknowledged !== true) throw new HttpError(400, '必须确认完整步骤、需求覆盖和方案差异');
      if (draftIssues(draft, old.model, old.revision).some(x => x.blocking)) throw new HttpError(400, '草稿仍有阻塞问题');
      if ((old.model?.currentPlanId ?? null) !== draft.candidate.previousPlanId) throw new HttpError(409, '前版方案不匹配');
      const confirmationGrantId = randomUUID();
      const grant = { confirmationGrantId, principal, draftId: id, draftRevision: draft.revision, sourceHash: draft.source.sourceHash,
        basisRevision: old.revision, projectRevision: old.projectRevision, diff: diff(draft, old), expiresAt: Date.now() + 15 * 60 * 1000 };
      const confirmationDigest = digest(grant);
      persistence.write('grants', { ...persistence.read('grants'), [confirmationGrantId]: { ...grant, confirmationDigest } });
      return { ...grant, confirmationDigest };
    }),
    publish: (id, input, principal = 'local-ui') => requests.execute(principal, id, 'draft.publish', input, async () => {
      const draft = drafts.get(id);
      if (draft.principal !== principal) throw new HttpError(403, '草稿不属于当前授权主体');
      if (draft.status === 'committed') {
        if (draft.publication.confirmationDigest !== input.confirmationDigest) throw new HttpError(409, '草稿已由其他确认发布');
        return draft.publication;
      }
      const old = await basis(draft), grant = persistence.read('grants')[input.confirmationGrantId];
      if (!grant || grant.principal !== principal || grant.draftId !== id || grant.confirmationDigest !== input.confirmationDigest || grant.sourceHash !== input.sourceHash || grant.draftRevision !== draft.revision || grant.basisRevision !== old.revision || grant.projectRevision !== old.projectRevision || grant.expiresAt < Date.now() || digest(grant.diff) !== digest(diff(draft, old))) throw new HttpError(409, 'CONFIRMATION_REQUIRED: 确认已过期或内容改变');
      if (draftIssues(draft, old.model, old.revision).some(x => x.blocking)) throw new HttpError(400, '发布校验失败');
      if (old.model) {
        const initial = old.model.plans.find(p => p.id === old.model.initialPlanId);
        if ((initial?.initialGoal ?? initial?.goal) !== draft.candidate.initialGoal) throw new HttpError(400, '初始目标不可覆盖');
        const original = old.model.initialRequirements ?? [];
        if (original.some(r => !draft.candidate.requirements.some(n => n.requirementId === r.requirementId && n.originalText === r.originalText))) throw new HttpError(400, '原始需求不可删除或覆盖');
      }
      const projectBody = projectFromDraft(draft);
      if (!old.model) await projects.create(projectBody, draft.projectId);
      else await projects.update(draft.projectId, { ...projectBody, revision: old.projectRevision }, true);
      const current = await models.get(draft.projectId);
      const value = await models.publish(draft.projectId, { revision: current.revision, model: materialize(draft, old.model ?? undefined) });
      const publication = { publicationId: randomUUID(), projectId: draft.projectId, planId: draft.planId, draftId: id, revision: value.revision, confirmationDigest: input.confirmationDigest };
      persistence.write('drafts', { ...persistence.read('drafts'), [id]: { ...draft, status: 'committed', publication } });
      return publication;
    }),
  };
}
