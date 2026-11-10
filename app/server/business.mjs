import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { requireShape } from './business-schema.mjs';
import { HttpError, exactKeys } from './validation.mjs';
import { applyStart, inspectMonitor, startScope } from './monitor.mjs';
import { applyReceiptCommand, digest } from './receipts.mjs';

const fail = message => { throw new HttpError(400, message); };
const text = value => { if (typeof value !== 'string' || !value.trim()) fail('必需文本缺失'); return value; };
const now = () => new Date().toISOString();
const worktreeKey = value => path.win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase();
function stateOf(model) {
  model.business ??= { repairs: [], attempts: [], executions: [], claims: [], handovers: [], lateResults: [], refinements: [], scopeCandidates: [], blockers: [] };
  model.business.merges ??= [];
  model.business.reassessments ??= [];
  return model.business;
}
function stationOf(model, stationId) {
  const station = model.stations.find(s => s.id === stationId);
  if (!station || station.planId !== model.currentPlanId) fail('当前方案站点不存在');
  return station;
}
function bindingOf(projectId, model, scope) {
  const station = stationOf(model, scope.stationId);
  const task = model.tasks.find(t => t.id === station.taskId);
  const binding = model.bindings?.find(b => b.bindingId === scope.bindingId);
  if (!binding || binding.revokedAt || binding.bindingRevision !== scope.bindingRevision ||
      ['projectId', 'folderId', 'taskId', 'planId', 'sourceId'].some(k => binding[k] !== scope[k]) || scope.projectId !== projectId ||
      scope.planId !== model.currentPlanId || station.planId !== scope.planId || station.taskId !== scope.taskId || task.folderId !== scope.folderId || binding.stationId && binding.stationId !== station.id) throw new HttpError(409, 'STALE_BINDING');
  return binding;
}
function contextOf(model, binding, input, executionId) {
  requireShape('workContextDeclaration', input);
  if (input.dirty && !input.contentFingerprint) fail('dirty 交付必须保存内容指纹');
  if (input.sourceId && input.sourceId !== binding.sourceId || input.executionId && executionId && input.executionId !== executionId) fail('工作上下文来源或执行不匹配');
  const confirmed = model.bindingContexts?.[binding.bindingId];
  if (!confirmed || worktreeKey(confirmed.worktreePath) !== worktreeKey(input.worktreePath) || confirmed.branchName !== input.branchName || confirmed.repositoryId !== input.repositoryId) throw new HttpError(409, 'STALE_BINDING: 工作树或分支变化需重新确认');
  return { ...input, sourceId: binding.sourceId, executionId, verification: 'declared' };
}
function anchor(projectId, model, station, revision, conditionIds) {
  return { projectId, taskId: station.taskId, stationId: station.id, planId: model.currentPlanId, conditionIds,
    dependencyStationIds: station.dependsOn, successorStationIds: station.successors,
    mergeStationIds: station.successors.filter(id => model.stations.find(s => s.id === id)?.dependsOn.length > 1), basisRevision: revision };
}
function checkConditions(station, ids) {
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => !station.conditions?.some(c => c.conditionId === id))) fail('必须引用原站稳定验收条件');
}
function ownExecution(state, scope) {
  const execution = state.executions.find(e => e.executionId === scope.executionId && e.stationId === scope.stationId);
  if (!execution) fail('执行不存在');
  return execution;
}
function currentOwner(execution, binding) { return execution.bindingId === binding.bindingId && execution.bindingRevision === binding.bindingRevision && execution.sourceId === binding.sourceId; }
function currentExecution(state, execution, binding) {
  return currentOwner(execution, binding) && state.executions.filter(e => e.stationId === execution.stationId).at(-1)?.executionId === execution.executionId;
}
function begin(projectId, model, revision, scope, workContext, evidence, startedAt, repairId) {
  const state = stateOf(model), binding = bindingOf(projectId, model, scope), station = stationOf(model, scope.stationId);
  const context = contextOf(model, binding, workContext, null);
  const view = inspectMonitor(projectId, model), status = view.stations.find(s => s.id === station.id);
  if (!status.ready || status.state === 'done' || state.executions.some(e => e.stationId === station.id && e.outcome === 'running')) fail('前置未满足或已有执行');
  const claim = state.claims.filter(c => c.stationId === station.id && !c.endedAt).at(-1);
  if (!claim || claim.bindingId !== binding.bindingId) fail('开始前必须认领本站');
  const executionId = randomUUID();
  const execution = { executionId, stationId: station.id, taskId: station.taskId, planId: model.currentPlanId, bindingId: binding.bindingId,
    bindingRevision: binding.bindingRevision, sourceId: binding.sourceId, workContext: { ...context, executionId }, startedAt, recordedAt: now(), evidence: text(evidence), outcome: 'running', repairId: repairId ?? null };
  state.executions.push(execution);
  claim.executionId = executionId;
  // Repair starts may follow an ended execution whose receipt is still pending.
  if (repairId) {
    model.lifecycle ??= { starts: [], closures: [], events: [], receiptPositions: {} };
    model.lifecycle.starts.push({ id: randomUUID(), stationId: station.id, sourceId: binding.sourceId, executionId, evidence, scopeHash: startScope(station), sequence: model.lifecycle.events.length + 1, time: startedAt });
    model.lifecycle.events.push({ id: randomUUID(), type: 'repair-started', executionId, time: now() });
  } else {
    const changed = applyStart(projectId, model, { stationId: station.id, sourceId: binding.sourceId, executionId, evidence });
    model.lifecycle = changed.lifecycle;
  }
  return execution;
}

export function createBusiness(persistence, requests, models) {
  function command(projectId, input, principal = 'local-ui') {
    const operation = input.operation;
    return requests.execute(principal, projectId, `business.${operation}`, input, async () => {
      let result;
      const saved = await models.mutate(projectId, input.expectedRevision, (model, revision) => {
        const state = stateOf(model);
        if (operation === 'bind') {
          exactKeys(input, ['operation', 'expectedRevision', 'idempotencyKey', 'taskId', 'stationId', 'sourceId', 'provider', 'hostId', 'dataRootId', 'sessionId', 'threadId', 'confirmationRef', 'workContext'], 'bind');
          const task = model.tasks.find(t => t.id === input.taskId);
          const chat = model.chats.find(c => c.id === input.sourceId);
          if (!task?.folderId || !chat || chat.taskId !== task.id || chat.folderId !== task.folderId) fail('来源与任务归属不匹配');
          if (input.stationId && stationOf(model, input.stationId).taskId !== task.id) fail('站点与任务不匹配');
          requireShape('workContextDeclaration', input.workContext);
          const binding = { bindingId: randomUUID(), bindingRevision: 1, projectId, folderId: task.folderId, taskId: task.id, stationId: input.stationId ?? null, planId: model.currentPlanId,
            sourceId: chat.id, provider: text(input.provider), hostId: text(input.hostId), dataRootId: text(input.dataRootId), sessionId: text(input.sessionId), threadId: input.threadId ?? null,
            confirmationRef: text(input.confirmationRef), confirmedAt: now(), sourceTrust: 'userConfirmed', revokedAt: null };
          requireShape('binding', binding);
          model.bindings = [...(model.bindings ?? []), binding];
          model.bindingContexts = { ...model.bindingContexts, [binding.bindingId]: input.workContext };
          result = { binding };
        } else if (operation === 'revoke') {
          exactKeys(input, ['operation', 'expectedRevision', 'idempotencyKey', 'bindingId', 'reason'], 'revoke');
          const binding = model.bindings?.find(b => b.bindingId === input.bindingId);
          if (!binding || binding.revokedAt) fail('有效绑定不存在');
          binding.revokedAt = now(); binding.bindingRevision++;
          binding.confirmationRef += `\n撤销 ${text(input.reason)}`;
          result = { binding };
        } else if (['start', 'repair', 'blocker', 'receipt'].includes(operation)) {
          const tool = { start: 'workbench_record_start', repair: 'workbench_record_repair', blocker: 'workbench_record_blocker', receipt: 'workbench_submit_receipt' }[operation];
          const { operation: ignored, ...body } = input;
          requireShape(`${tool}_input`, body);
          if (body.projectId !== projectId) fail('项目不匹配');
          const binding = bindingOf(projectId, model, body.scope), station = stationOf(model, body.scope.stationId);
          if (operation === 'blocker' || operation === 'repair' && body.action === 'createCase') {
            const execution = ownExecution(state, body.scope);
            if (!currentExecution(state, execution, binding)) {
              state.lateResults.push({ id: randomUUID(), body, recordedAt: now(), reason: '过期执行或旧来源迟到登记' });
              result = { historicalOnly: true }; return model;
            }
          }
          if (operation === 'start') {
            if (body.repairId) fail('修复尝试从 appendAttempt 开始');
            result = begin(projectId, model, revision, body.scope, body.workContext, body.evidence, body.startedAt);
          } else if (operation === 'repair') {
            if (body.action === 'createCase') {
              const c = body.case;
              checkConditions(station, c.failedConditionIds); checkConditions(station, c.closeConditions);
              if (c.triggerReceiptId && !model.receiptLog?.receipts.some(r => r.id === c.triggerReceiptId && r.receipt.stationId === station.id)) fail('触发回执不属于原站');
              if (c.scopeClass !== 'requiredRepair') fail('新增范围和待确认事项应先进入范围候选');
              const expected = anchor(projectId, model, station, revision, c.failedConditionIds);
              if (digest(c.returnAnchor) !== digest(expected)) fail('回归锚点与当前站点不一致');
              const repair = { repairId: randomUUID(), projectId, taskId: station.taskId, stationId: station.id, planId: model.currentPlanId, ...c, status: 'inProgress', revision: 1 };
              requireShape('RepairCase', repair); state.repairs.push(repair); result = repair;
            } else {
              const repair = state.repairs.find(r => r.repairId === body.repairId && r.stationId === station.id);
              if (!repair || repair.planId !== model.currentPlanId) fail('修复案例需要按当前方案重新核对');
              if (state.merges.some(m => m.sourceRepairId === repair.repairId)) fail('重复案例已合并，请续接主案例');
              if (body.action === 'appendAttempt') {
                if (state.attempts.some(a => a.repairId === repair.repairId && a.outcome === 'running')) fail('已有运行中的修复尝试');
                const execution = begin(projectId, model, revision, body.scope, body.attempt.workContext, body.attempt.method, body.attempt.startedAt, repair.repairId);
                const attempt = { attemptId: randomUUID(), repairId: repair.repairId, executionId: execution.executionId, sourceId: binding.sourceId,
                  workContext: execution.workContext, goal: body.attempt.goal, method: body.attempt.method, startedAt: body.attempt.startedAt,
                  endedAt: null, actualChanges: [], deliveryVersion: null, checks: [], evidence: [], unresolved: [], outcome: 'running' };
                requireShape('RepairAttempt', attempt); state.attempts.push(attempt); repair.status = 'inProgress'; repair.revision++; result = attempt;
              } else {
                const attempt = state.attempts.find(a => a.attemptId === body.attemptId && a.repairId === repair.repairId && a.executionId === body.scope.executionId);
                if (!attempt || attempt.outcome !== 'running') fail('运行中的尝试不存在');
                const execution = ownExecution(state, body.scope);
                if (!currentExecution(state, execution, binding)) {
                  state.lateResults.push({ id: randomUUID(), body, recordedAt: now(), reason: '接手后旧来源迟到结果' });
                  result = { historicalOnly: true }; return model;
                }
                const resolution = body.resolution;
                if (resolution.checks.some(c => !repair.closeConditions.includes(c.conditionId)) || resolution.evidence.some(e => e.deliveryVersion !== resolution.deliveryVersion)) fail('条件或证据适用版本不匹配');
                Object.assign(attempt, resolution);
                execution.outcome = resolution.outcome; execution.endedAt = resolution.endedAt; execution.deliveryVersion = resolution.deliveryVersion;
                repair.status = resolution.outcome === 'pendingReview' ? 'pendingReview' : 'inProgress'; repair.revision++;
                result = { repairId: repair.repairId, attemptId: attempt.attemptId, status: repair.status };
              }
            }
          } else if (operation === 'blocker') {
            ownExecution(state, body.scope);
            if (body.action === 'block') {
              const blocker = { blockerId: randomUUID(), stationId: station.id, executionId: body.scope.executionId, sourceId: binding.sourceId, reason: body.reason, waitingFor: body.waitingFor, releaseConditions: body.releaseConditions, occurredAt: body.occurredAt, recordedAt: now(), status: 'blocked' };
              state.blockers.push(blocker); result = blocker;
            } else {
              const blocker = state.blockers.find(b => b.blockerId === body.blockerId && b.stationId === station.id);
              if (!blocker) fail('阻塞不存在');
              Object.assign(blocker, { status: 'resolved', resolutionEvidence: body.resolutionEvidence, resolvedAt: body.occurredAt }); result = blocker;
            }
          } else {
            const execution = ownExecution(state, body.scope);
            if (!currentExecution(state, execution, binding)) {
              state.lateResults.push({ id: randomUUID(), body, recordedAt: now(), reason: '接手后旧来源迟到回执' });
              result = { historicalOnly: true }; return model;
            }
            const workContext = contextOf(model, binding, body.workContext, execution.executionId);
            if (body.evidence.some(e => e.deliveryVersion !== body.deliveryVersion)) fail('证据版本不适用');
            const checks = body.checks.map(c => ({ ...c, criterion: station.conditions.find(a => a.conditionId === c.conditionId)?.originalText ?? fail('验收条件不属于本站') }));
            const receipt = { ...body.scope, deliveryVersion: body.deliveryVersion, actual: body.actual, raw: body.raw, checks, next: body.next,
              blockers: body.unresolved, workContext, evidence: body.evidence, outcome: body.outcome, endedAt: body.endedAt, repairId: body.repairId ?? null, attemptId: body.attemptId ?? null };
            if (execution.outcome !== 'running' && (execution.endedAt !== body.endedAt || execution.deliveryVersion !== body.deliveryVersion || execution.outcome !== (body.outcome === 'delivered' ? 'pendingReview' : body.outcome))) fail('已结束执行不能再次覆盖');
            const receiptHash = digest(receipt);
            if (execution.receiptHash && execution.receiptHash !== receiptHash) fail('同次执行的回执不可覆盖');
            execution.receiptHash = receiptHash;
            execution.outcome = body.outcome; execution.endedAt = body.endedAt; execution.deliveryVersion = body.deliveryVersion;
            if (body.attemptId) {
              const attempt = state.attempts.find(a => a.attemptId === body.attemptId && a.executionId === execution.executionId && a.repairId === body.repairId);
              if (!attempt) fail('修复尝试归属不匹配');
              Object.assign(attempt, { deliveryVersion: body.deliveryVersion, actualChanges: [body.actual], checks: body.checks, evidence: body.evidence, unresolved: body.unresolved, endedAt: body.endedAt, outcome: body.outcome === 'delivered' ? 'pendingReview' : body.outcome });
              state.repairs.find(r => r.repairId === body.repairId).status = body.outcome === 'delivered' ? 'pendingReview' : 'inProgress';
            }
            const changed = applyReceiptCommand(projectId, model, { action: 'import', receipt });
            model.receiptLog = changed?.receiptLog ?? model.receiptLog;
            result = { receiptId: model.receiptLog.receipts.at(-1).id, executionId: execution.executionId, verification: 'pending' };
          }
        } else if (['claim', 'takeover'].includes(operation)) {
          exactKeys(input, ['operation', 'expectedRevision', 'idempotencyKey', 'scope', 'workContext', 'reason', 'allowedPaths'], operation);
          requireShape('scope', input.scope);
          const binding = bindingOf(projectId, model, input.scope), station = stationOf(model, input.scope.stationId);
          const workContext = contextOf(model, binding, input.workContext, input.scope.executionId);
          const current = state.claims.filter(c => c.stationId === station.id && !c.endedAt).at(-1);
          if (!Array.isArray(input.allowedPaths) || input.allowedPaths.some(p => typeof p !== 'string' || !p.trim() || p.split(/[\\/]/).some(segment => segment === '..' || segment === '.') || path.win32.isAbsolute(p) || p.includes(':'))) fail('允许并行范围非法');
          const allowedPaths = input.allowedPaths.map(p => p.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase());
          const claims = Object.values(persistence.read('models')).flatMap(v => v.model.business?.claims ?? []);
          const overlaps = (a, b) => !a.length || !b.length || a.some(x => b.some(y => x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)));
          if (claims.some(c => c.claimId !== current?.claimId && !c.endedAt && worktreeKey(c.workContext.worktreePath) === worktreeKey(workContext.worktreePath) && overlaps(c.allowedPaths, allowedPaths))) fail('同一工作树并行修改范围冲突');
          if (operation === 'claim') {
            if (current) fail('本站已认领，需明确接手');
            const claim = { claimId: randomUUID(), stationId: station.id, bindingId: binding.bindingId, sourceId: binding.sourceId, workContext, allowedPaths, reason: text(input.reason), startedAt: now(), endedAt: null, executionId: null };
            state.claims.push(claim); result = claim;
          } else {
            if (!current) fail('没有可接手认领');
            const execution = current.executionId && state.executions.find(e => e.executionId === current.executionId);
            state.handovers.push({ id: randomUUID(), claimId: current.claimId, fromSourceId: current.sourceId, toSourceId: binding.sourceId, executionId: execution?.executionId ?? null, reason: text(input.reason), time: now() });
            Object.assign(current, { sourceId: binding.sourceId, bindingId: binding.bindingId, workContext, allowedPaths });
            if (execution) Object.assign(execution, { sourceId: binding.sourceId, bindingId: binding.bindingId, bindingRevision: binding.bindingRevision, workContext: { ...workContext, executionId: execution.executionId } });
            result = { claim: current, executionId: execution?.executionId ?? null };
          }
        } else if (operation === 'release') {
          exactKeys(input, ['operation', 'expectedRevision', 'idempotencyKey', 'claimId', 'reason'], 'release');
          const claim = state.claims.find(c => c.claimId === input.claimId && !c.endedAt);
          if (!claim || state.executions.some(e => e.executionId === claim.executionId && e.outcome === 'running')) fail('认领不存在或执行尚未结束');
          claim.endedAt = now(); claim.releaseReason = text(input.reason); result = claim;
        } else if (operation === 'refine') {
          exactKeys(input, ['operation', 'expectedRevision', 'idempotencyKey', 'stationId', 'conditionIds', 'title', 'goal', 'changesContract'], 'refine');
          const station = stationOf(model, input.stationId); checkConditions(station, input.conditionIds);
          if (input.changesContract !== false) fail('改变交付、依赖或验收应提出方案修订候选');
          const refinement = { id: randomUUID(), parentStationId: station.id, parentGoal: station.goal ?? station.scope, conditionIds: input.conditionIds, title: text(input.title), goal: text(input.goal), planId: model.currentPlanId, time: now() };
          state.refinements.push(refinement); result = refinement;
        } else if (operation === 'scopeCandidate') {
          exactKeys(input, ['operation', 'expectedRevision', 'idempotencyKey', 'stationId', 'title', 'reason'], 'scopeCandidate');
          stationOf(model, input.stationId);
          const candidate = { id: randomUUID(), stationId: input.stationId, title: text(input.title), reason: text(input.reason), status: 'pendingConfirmation', scopeClass: 'newScopeCandidate', planId: model.currentPlanId, time: now() };
          state.scopeCandidates.push(candidate); result = candidate;
        } else if (operation === 'reassess') {
          exactKeys(input, ['operation', 'expectedRevision', 'idempotencyKey', 'repairId', 'decision', 'reason', 'threshold'], 'reassess');
          const repair = state.repairs.find(r => r.repairId === input.repairId);
          if (!repair || !['continueMethod', 'changeMethod', 'splitWithinScope', 'waitExternal', 'proposePlanChange'].includes(input.decision) || !Number.isInteger(input.threshold) || input.threshold < 1) fail('重新评估决定、阈值或原案例不完整');
          const decision = { id: randomUUID(), repairId: repair.repairId, decision: input.decision, reason: text(input.reason), threshold: input.threshold, confirmedBy: principal, time: now() };
          state.reassessments.push(decision); result = decision;
        } else if (operation === 'merge') {
          exactKeys(input, ['operation', 'expectedRevision', 'idempotencyKey', 'repairId', 'duplicateRepairId', 'reason'], 'merge');
          const target = state.repairs.find(r => r.repairId === input.repairId), duplicate = state.repairs.find(r => r.repairId === input.duplicateRepairId);
          if (!target || !duplicate || target === duplicate || target.stationId !== duplicate.stationId || target.planId !== duplicate.planId || digest([...target.closeConditions].sort()) !== digest([...duplicate.closeConditions].sort()) || state.merges.some(m => [target.repairId, duplicate.repairId].includes(m.sourceRepairId)) || state.attempts.some(a => [target.repairId, duplicate.repairId].includes(a.repairId) && a.outcome === 'running')) fail('合并必须引用同站同条件的已结束案例，且保留计数出处');
          const merge = { id: randomUUID(), targetRepairId: target.repairId, sourceRepairId: duplicate.repairId, reason: text(input.reason), time: now() };
          state.merges.push(merge); result = merge;
        } else if (operation === 'reopen') {
          exactKeys(input, ['operation', 'expectedRevision', 'idempotencyKey', 'repairId', 'reason'], 'reopen');
          const repair = state.repairs.find(r => r.repairId === input.repairId);
          if (!repair) fail('修复案例不存在');
          if (state.merges.some(m => m.sourceRepairId === repair.repairId)) fail('请重开合并后的主案例');
          repair.status = 'recheck'; repair.revision++;
          repair.reopenHistory = [...(repair.reopenHistory ?? []), { time: now(), reason: text(input.reason), afterReviewId: inspectMonitor(projectId, model).inspection.results[repair.stationId]?.reviewId ?? null }];
          result = repair;
        } else fail('不支持的业务操作');
        return model;
      });
      return { ...result, revision: saved.revision };
    });
  }
  return { command };
}
