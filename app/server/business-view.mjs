import { headDigest } from './receipts.mjs';

export function coverageGaps(model) {
  if (!model.schemaVersion) return [];
  const requirements = model.requirements ?? [];
  const missing = (model.initialRequirements ?? []).filter(original => !requirements.some(r => r.requirementId === original.requirementId && r.originalText === original.originalText));
  return [...missing, ...requirements.filter(r => !r.stationIds.length || !r.conditionIds.length || r.stationIds.some(id => !model.stations.some(s => s.id === id)) || r.conditionIds.some(id => !model.stations.filter(s => r.stationIds.includes(s.id)).some(s => s.conditions?.some(c => c.conditionId === id))))];
}

export function repairStates(model, log) {
  const merges = model.business?.merges ?? [];
  return (model.business?.repairs ?? []).filter(r => !merges.some(m => m.sourceRepairId === r.repairId)).map(repair => {
    const station = model.stations.find(s => s.id === repair.stationId);
    const aliases = new Set([repair.repairId]);
    for (let i = 0; i < merges.length; i++) for (const merge of merges) if (aliases.has(merge.targetRepairId)) aliases.add(merge.sourceRepairId);
    const attempts = model.business.attempts.filter(a => aliases.has(a.repairId));
    const last = attempts.at(-1);
    const receipt = log.receipts.filter(r => r.receipt.stationId === repair.stationId && r.receipt.deliveryVersion === last?.deliveryVersion && r.receipt.executionId === last?.executionId).at(-1);
    const review = receipt && log.reviews.filter(r => r.receiptId === receipt.id).at(-1);
    const reopenedAfter = repair.reopenHistory?.at(-1)?.afterReviewId;
    const verified = repair.status === 'pendingReview' && last?.outcome === 'pendingReview' && !last.unresolved.length && repair.planId === model.currentPlanId && review && review.headHash === headDigest(model, receipt.receipt) && review.id !== reopenedAfter && !log.invalidations.some(i => i.reviewId === review.id) && repair.closeConditions.every(id => {
      const criterion = station?.conditions?.find(c => c.conditionId === id)?.originalText;
      const check = review.review.checks.find(c => c.criterion === criterion);
      return check?.result === 'passed' && check.evidenceIds.length && check.evidenceIds.every(id => review.review.evidence.some(e => e.id === id && e.result === 'valid' && e.deliveryVersion === last.deliveryVersion));
    });
    const decision = model.business.reassessments?.filter(d => aliases.has(d.repairId)).at(-1);
    const threshold = decision?.threshold ?? 2;
    const recent = attempts.slice(-threshold);
    return { ...repair, mergedCaseIds: [...aliases].filter(id => id !== repair.repairId), status: verified ? 'resolved' : repair.status, attempts, rounds: attempts.length,
      failed: attempts.filter(a => a.outcome === 'failed').length, interrupted: attempts.filter(a => a.outcome === 'interrupted').length,
      pending: attempts.filter(a => a.outcome === 'pendingReview').length,
      reassessmentSuggested: recent.length === threshold && recent.every(a => ['failed', 'interrupted'].includes(a.outcome) && JSON.stringify(a.unresolved.slice().sort()) === JSON.stringify(last.unresolved.slice().sort())),
      reassessmentDecision: decision ?? null, reassessmentThreshold: { rounds: threshold, confirmed: !!decision } };
  });
}

export function resumeContext(projectId, model, revision, view, stationId) {
  const station = model.stations.find(s => s.id === stationId) ?? model.stations[0];
  const repairs = repairStates(model, view.inspection.log).filter(r => !station || r.stationId === station.id);
  const activeRepairs = repairs.filter(r => r.status !== 'resolved');
  const blockers = (model.business?.blockers ?? []).filter(b => b.status === 'blocked' && b.stationId === station?.id);
  const result = station && view.inspection.results[station.id];
  const disposition = blockers.length || result?.waiting?.length ? 'wait_dependency' : activeRepairs.some(r => r.status !== 'pendingReview') ? 'continue_repair' : activeRepairs.length ? 'wait_verification' : !result?.receiptId ? 'continue_station' : ({ A: 'continue_station', B: 'wait_verification', C: 'wait_dependency', D: 'handoff_successor', E: 'end_task', F: 'end_project', G: 'continue_station' }[result?.conclusion] ?? 'continue_station');
  const initial = model.plans.find(p => p.id === model.initialPlanId);
  const latestReceipt = view.inspection.log.receipts.find(r => r.id === result?.receiptId);
  return { projectId, basisRevision: revision, totalGoal: initial?.initialGoal ?? initial?.goal ?? null, currentPlanId: model.currentPlanId, stationId: station?.id ?? null, stationCode: station?.code ?? null,
    originalGoal: station?.goal ?? station?.scope ?? null, originalConditions: station?.conditions ?? station?.acceptance ?? [],
    repairs, attempts: repairs.flatMap(r => r.attempts), returnAnchors: repairs.map(r => r.returnAnchor),
    latestDelivery: latestReceipt?.receipt.deliveryVersion ?? null, waitingFor: [...(result?.waiting ?? []), ...blockers.flatMap(b => b.waitingFor)], blockers,
    disposition, coverageGaps: coverageGaps(model), mainStationCount: model.stations.length,
    repairRounds: repairs.reduce((n, r) => n + r.rounds, 0), unresolvedCases: activeRepairs.length,
    workContext: model.business?.executions.filter(e => e.stationId === station?.id).at(-1)?.workContext ?? null,
    claims: model.business?.claims ?? [], refinements: model.business?.refinements ?? [], scopeCandidates: model.business?.scopeCandidates ?? [],
    trackingCoverage: 'unknown', trackingReason: 'U03 固定输入业务登记，真实会话与事件观察由 U04 验证' };
}
