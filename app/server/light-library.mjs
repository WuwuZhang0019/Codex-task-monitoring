// Date: 2026-11-18. Owner-only route archival, pause checkpoints and transactional deletion.
import { randomUUID } from 'node:crypto';
import { digest } from './receipts.mjs';
import { bindingOwnsStep, hasUserPauseCheckpoint, lightError, validateLightSnapshot } from './light-model.mjs';

export function touches(value, keys) {
  if (typeof value === 'string') return keys.has(value);
  if (Array.isArray(value)) return value.some(item => touches(item, keys));
  return value && typeof value === 'object' && Object.entries(value).some(([key, item]) => keys.has(key) || touches(item, keys));
}

function relatedPlans(snapshot, project, plan) {
  const stepByKey = new Map(snapshot.steps.map(item => [item.key, item]));
  const projectPlans = new Set(snapshot.plans.filter(item => item.projectKey === project.key).map(item => item.key));
  const pausedPlans = new Set(plan ? [plan.key] : [...projectPlans]);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const item of snapshot.routes) {
      if (!projectPlans.has(item.planKey)) continue;
      for (const ref of [item.sourceStepKey, item.returnStepKey]) {
        const sourcePlan = stepByKey.get(ref)?.planKey;
        if (sourcePlan && projectPlans.has(sourcePlan) && pausedPlans.has(sourcePlan) !== pausedPlans.has(item.planKey)) {
          pausedPlans.add(sourcePlan); pausedPlans.add(item.planKey); expanded = true;
        }
      }
    }
    for (const item of snapshot.supplements) {
      const sourcePlan = stepByKey.get(item.sourceStepKey)?.planKey;
      if (sourcePlan && item.linkedPlanKey && projectPlans.has(sourcePlan) && projectPlans.has(item.linkedPlanKey)
        && pausedPlans.has(sourcePlan) !== pausedPlans.has(item.linkedPlanKey)) {
        pausedPlans.add(sourcePlan); pausedPlans.add(item.linkedPlanKey); expanded = true;
      }
    }
  }
  return pausedPlans;
}

function taskScope(snapshot, key) {
  const route = snapshot.routes.find(item => item.key === key);
  const plan = snapshot.plans.find(item => item.key === (route?.planKey ?? key));
  const project = snapshot.projects.find(item => item.key === (plan?.projectKey ?? key));
  return { route, plan, project };
}

function checkChange(snapshot, input) {
  if (!input || input.acknowledged !== true || Object.keys(input).sort().join(',') !== 'acknowledged,expectedRevision,key'
    || typeof input.key !== 'string' || !input.key || !Number.isSafeInteger(input.expectedRevision)) {
    lightError('INVALID_INPUT', '需要条目、版本和明确确认');
  }
  if (!snapshot) lightError('NOT_FOUND', '任务不存在', 404);
  if (snapshot.revision !== input.expectedRevision) lightError('REVISION_CONFLICT', '任务已更新，请刷新后重试', 409);
}

function pausedTargets(value, key, runs) {
  const { snapshot } = value;
  const { project, plan } = taskScope(snapshot, key);
  if (!project) lightError('NOT_FOUND', '列表条目不存在', 404);
  const plans = relatedPlans(snapshot, project, plan);
  const targets = new Map();
  for (const step of snapshot.steps) {
    if (!plans.has(step.planKey) || step.parentKey !== null || !hasUserPauseCheckpoint(step)) continue;
    const execution = snapshot.executions.find(item => item.planKey === step.planKey && item.stepKeys.includes(step.key)
      && !item.endedAt && item.outcome === 'running' && (!step.executionKey || item.key === step.executionKey));
    const binding = snapshot.bindings.find(item => item.key === execution?.bindingKey && item.planKey === step.planKey
      && item.state === 'confirmed' && !item.revokedAt && bindingOwnsStep(snapshot, item, step));
    if (!binding?.context.threadId || binding.context.hostId !== 'local' || !binding.context.worktreePath) {
      lightError('TASK_RESUME_CONTEXT', '找不到可接续的本机原会话，请回到执行聊天核对绑定', 409);
    }
    const { threadId, worktreePath } = binding.context;
    const target = targets.get(threadId) ?? {
      threadId, worktreePath, steps: [],
      ownedRunId: runs.find(run => run.current?.threadId === threadId && !run.current.adopted && run.current.transport !== 'shared')?.id,
    };
    if (target.worktreePath !== worktreePath) lightError('TASK_RESUME_CONTEXT', '原会话关联了不同工作目录，请核对绑定', 409);
    const checkpoint = snapshot.events.findLast(event => event.stepKey === step.key && event.toStatus === 'blocked'
      && !event.eventId.startsWith('light/resume/'))?.eventId
      ?? digest([step.key, step.updatedAt]);
    const targetPlan = snapshot.plans.find(item => item.key === step.planKey);
    target.steps.push({ projectId: project.id, planId: targetPlan.id, sourcePath: targetPlan.source.path,
      stepId: step.id, stepKey: step.key, code: step.code, title: step.title, bindingId: binding.id,
      bindingRevision: binding.bindingRevision, executionId: execution.id, checkpoint });
    targets.set(threadId, target);
  }
  return [...targets.values()];
}

export function createLightLibrary(persistence, { pauseContinuous, connectResume } = {}) {
  let resuming = false;
  const runs = () => persistence.read('lightContinuous')?.runs ?? [];
  const attempts = value => value.metadata.taskResumeAttempts ??= [];

  async function resume(input) {
    if (resuming) lightError('TASK_RESUME_BUSY', '正在接续，请等待原会话返回结果', 409);
    const initial = persistence.read('light');
    checkChange(initial?.snapshot, input);
    const targets = pausedTargets(initial, input.key, runs());
    if (!targets.length) lightError('TASK_RESUME_CONTEXT', '当前没有可同步恢复状态的暂停父任务', 409);
    if (!connectResume) lightError('TASK_RESUME_UNAVAILABLE', '原会话连接不可用，请在原执行聊天继续', 409);
    resuming = true;
    try {
      for (const pending of targets) {
        const checkpointIds = new Set(pending.steps.map(step => step.checkpoint));
        const prior = attempts(persistence.read('light')).filter(attempt => attempt.threadId === pending.threadId
          && attempt.checkpointIds.some(id => checkpointIds.has(id)));
        if (prior.some(attempt => attempt.state === 'sending')) {
          lightError('TASK_RESUME_UNKNOWN', '继续指令是否送达尚未确认，请在原执行聊天核对', 409);
        }
        const delivered = new Set(prior.flatMap(attempt => attempt.checkpointIds));
        const unsent = target => ({ ...target, steps: target.steps.filter(step => !delivered.has(step.checkpoint)) });
        const target = unsent(pending);
        if (!target.steps.length) continue;
        const targetHash = digest(target);
        const client = await connectResume(target);
        try {
          await persistence.run(() => {
            const value = persistence.read('light');
            const fresh = pausedTargets(value, input.key, runs()).find(item => item.threadId === target.threadId);
            if (!fresh || digest(unsent(fresh)) !== targetHash) lightError('REVISION_CONFLICT', '暂停步骤或执行绑定已更新，请刷新后重试', 409);
            attempts(value).push({ id: targetHash, threadId: target.threadId, checkpointIds: target.steps.map(step => step.checkpoint),
              stepKeys: target.steps.map(step => step.stepKey), state: 'sending' });
            persistence.write('light', value);
          });
          const finish = state => persistence.run(() => {
            const value = persistence.read('light');
            const entries = attempts(value);
            const index = entries.findIndex(attempt => attempt.id === targetHash);
            if (index < 0) return;
            if (state === 'sent') entries[index].state = state;
            else entries.splice(index, 1);
            persistence.write('light', value);
          });
          try {
            const names = target.steps.map(step => `「${step.title}」`).join('、');
            const message = `继续父任务 ${names}，并同步任务岛状态。`
              + '本次只同步父任务的恢复状态。回读任务岛，核对暂停点、依赖、绑定和原执行身份，复用原执行记录提交 running。'
              + '只解除本次的 user-pause，用户已再次暂停或仍有其他阻塞时保留相应状态。'
              + '同步完成后等待用户指定具体工作。不要选择、启动或执行任何子任务，也不要推进其他步骤。\n'
              + JSON.stringify(target.steps.map(({ checkpoint, stepKey, ...identity }) => ({ ...identity, pauseCheckpoint: checkpoint })));
            const receipt = await client.notify(target.threadId, message);
            if (!receipt?.turnId) lightError('TASK_RESUME_UNKNOWN', '继续指令是否送达尚未确认，请在原执行聊天核对', 409);
          } catch (error) {
            if (['CODEX_DELIVERY_REJECTED', 'CODEX_THREAD_BUSY', 'CODEX_INTERACTION_REQUIRED', 'CODEX_ACTIVE_TURN_UNKNOWN'].includes(error.code)) {
              await finish('rejected');
              lightError('TASK_RESUME_UNAVAILABLE', '原执行聊天暂时无法接收指令，请在该聊天核对后重试', 409);
            }
            lightError('TASK_RESUME_UNKNOWN', '继续指令是否送达尚未确认，请在原执行聊天核对', 409);
          }
          await finish('sent');
        } finally {
          client.detach ? client.detach() : await client.close();
        }
      }
      return { saved: true, revision: persistence.read('light').snapshot.revision };
    } finally {
      resuming = false;
    }
  }

  return {
    isResuming: () => resuming,
    change(action, input) {
      if (action === 'resume') return resume(input);
      return persistence.run(() => {
        if (action === 'pause' && resuming) lightError('TASK_RESUME_BUSY', '正在发送继续指令，请稍后再暂停', 409);
        if (!['archive', 'restore', 'delete', 'pause'].includes(action)) lightError('INVALID_INPUT', '不支持的任务操作');
        const value = persistence.read('light'), snapshot = value?.snapshot;
        checkChange(snapshot, input);
        const { route, plan, project } = taskScope(snapshot, input.key);
        if (!project || (action !== 'pause' && ((!route && plan && snapshot.routes.some(item => item.planKey === plan.key))
          || (!route && !plan && snapshot.plans.some(item => item.projectKey === project.key))))) {
          lightError('NOT_FOUND', '列表条目不存在', 404);
        }
        const library = persistence.read('lightLibrary') ?? { version: 1, archived: [] };
        const archived = library.archived.find(item => item.key === input.key);
        const time = new Date().toISOString();
        if (action === 'pause') {
          const pausedPlans = relatedPlans(snapshot, project, plan);
          const inScope = item => pausedPlans.size ? pausedPlans.has(item.planKey) : item.projectKey === project.key;
          const openExecutionSteps = new Set(snapshot.executions
            .filter(item => inScope(item) && !item.endedAt && item.outcome === 'running')
            .flatMap(item => item.stepKeys ?? []));
          const targetSteps = snapshot.steps.filter(item =>
            inScope(item) && (item.status === 'running' || (openExecutionSteps.has(item.key) && item.status === 'pending')
              || (hasUserPauseCheckpoint(item) && item.blockers.every(blocker => blocker.resolved))));
          for (const step of targetSteps) {
            const fromStatus = step.status;
            step.status = 'blocked';
            step.updatedAt = time;
            step.sync = 'synced';
            const blocker = step.blockers.find(item => item.blockerId === 'user-pause');
            if (blocker) {
              blocker.reason = '用户在任务岛暂停任务';
              blocker.waitingFor = ['用户继续'];
              blocker.releaseConditions = ['明确继续后恢复原执行'];
              blocker.resolved = false;
            } else {
              step.blockers.push({
                blockerId: 'user-pause',
                reason: '用户在任务岛暂停任务',
                waitingFor: ['用户继续'],
                releaseConditions: ['明确继续后恢复原执行'],
                resolved: false,
              });
            }
            const eventId = `light/pause/${randomUUID()}`;
            snapshot.events.push({
              eventId, stepKey: step.key, executionKey: step.executionKey ?? null,
              fromStatus, toStatus: 'blocked', occurredAt: time, receivedAt: time,
              reason: '用户在任务岛暂停任务', evidenceIds: [], sync: 'synced',
            });
            value.history.push({ eventId, input: { key: input.key, stepKey: step.key, action: 'pause' }, previous: fromStatus, receivedAt: time });
          }
          if (targetSteps.length) project.revision += 1;
          const continuousState = persistence.read('lightContinuous');
          if (continuousState?.runs) {
            let continuousChanged = false;
            for (const run of [...continuousState.runs, ...(continuousState.acceptances ?? [])]) {
              if (pausedPlans.has(run.planKey) && run.status !== 'completed' && (run.enabled || ['running', 'pausing'].includes(run.status))) {
                run.enabled = false;
                run.status = 'paused';
                run.phase = null;
                run.reason = '用户在任务岛暂停任务';
                run.updatedAt = time;
                continuousChanged = true;
              }
            }
            if (continuousChanged) persistence.write('lightContinuous', continuousState);
          }
          pauseContinuous?.(pausedPlans);
        } else if (action === 'archive') {
          if (!archived) library.archived.push({ key: input.key, archivedAt: time });
        } else if (action === 'restore') {
          library.archived = library.archived.filter(item => item.key !== input.key);
        } else {
          if (!archived) lightError('ARCHIVE_REQUIRED', '请先归档，再从归档区删除', 409);
          const removedSteps = new Set(route?.stepKeys ?? snapshot.steps.filter(item => item.planKey === plan?.key).map(item => item.key));
          for (const step of snapshot.steps) if (removedSteps.has(step.parentKey)) removedSteps.add(step.key);
          const removedPlans = new Set(plan && !snapshot.steps.some(item => item.planKey === plan.key && !removedSteps.has(item.key)) ? [plan.key] : []);
          const removedProjects = new Set(!snapshot.plans.some(item => item.projectKey === project.key && !removedPlans.has(item.key)) ? [project.key] : []);
          const removedBindings = new Set(snapshot.bindings.filter(item => removedPlans.has(item.planKey)
            || item.stepKeys.length && item.stepKeys.every(key => removedSteps.has(key))).map(item => item.key));
          const conflicts = [
            ...snapshot.steps.filter(item => !removedSteps.has(item.key) && (item.dependsOn.some(key => removedSteps.has(key))
              || removedBindings.has(item.bindingKey) || item.blockers.some(blocker => blocker.waitingFor.some(key => removedSteps.has(key))))),
            ...snapshot.executions.filter(item => !removedPlans.has(item.planKey) && item.stepKeys.some(key => !removedSteps.has(key)) && removedBindings.has(item.bindingKey)),
            ...snapshot.routes.filter(item => item !== route && (item.stepKeys.some(key => removedSteps.has(key))
              || removedSteps.has(item.sourceStepKey) || removedSteps.has(item.returnStepKey))),
            ...snapshot.supplements.filter(item => (removedSteps.has(item.sourceStepKey) && item.linkedPlanKey && !removedPlans.has(item.linkedPlanKey))
              || (!removedSteps.has(item.sourceStepKey) && removedPlans.has(item.linkedPlanKey))),
          ];
          if (conflicts.length) lightError('REFERENCED_TASK', `其他任务仍引用此路线：${conflicts.map(item => item.title ?? item.label ?? item.key).join('、')}`, 409);
          if (snapshot.steps.some(item => removedSteps.has(item.key) && item.status === 'running')
            || snapshot.executions.some(item => item.stepKeys.some(key => removedSteps.has(key)) && item.outcome === 'running')) {
            lightError('ACTIVE_TASK', '此路线仍在执行，请先结束执行后再删除', 409);
          }
          const removedKeys = new Set([...removedSteps, ...removedPlans, ...removedProjects, ...(route ? [route.key] : [])]);
          snapshot.steps = snapshot.steps.filter(item => !removedSteps.has(item.key));
          snapshot.routes = snapshot.routes.filter(item => !removedKeys.has(item.key));
          for (const group of ['bindings', 'executions']) {
            snapshot[group] = snapshot[group].filter(item => {
              if (removedPlans.has(item.planKey) || item.stepKeys.length && item.stepKeys.every(key => removedSteps.has(key))) {
                removedKeys.add(item.key); if (item.id) removedKeys.add(item.id); return false;
              }
              if (item.stepKeys.some(key => removedSteps.has(key))) {
                item.stepKeys = item.stepKeys.filter(key => !removedSteps.has(key));
                if (group === 'bindings' && item.bindingRevision) item.bindingRevision += 1;
              }
              return true;
            });
          }
          snapshot.supplements = snapshot.supplements.filter(item => {
            if (!removedSteps.has(item.sourceStepKey)) return true;
            removedKeys.add(item.key); if (item.id) removedKeys.add(item.id); return false;
          });
          const original = persistence.read('light').snapshot;
          for (const group of ['steps', 'routes', 'plans', 'projects']) {
            for (const item of original[group]) if (removedKeys.has(item.key) && item.id) removedKeys.add(item.id);
          }
          snapshot.plans = snapshot.plans.filter(item => !removedPlans.has(item.key));
          for (const item of snapshot.plans) {
            item.stageKeys = item.stageKeys.filter(key => !removedSteps.has(key)); item.stageCount = item.stageKeys.length;
          }
          snapshot.projects = snapshot.projects.filter(item => !removedProjects.has(item.key));
          for (const item of snapshot.projects) item.planKeys = item.planKeys.filter(key => !removedPlans.has(key));
          snapshot.events = snapshot.events.filter(item => !removedKeys.has(item.stepKey) && !removedKeys.has(item.executionKey));
          for (const item of original.events) if (!snapshot.events.some(event => event.eventId === item.eventId)) removedKeys.add(item.eventId);
          if (!removedProjects.has(project.key)) project.revision += 1;
          value.history = value.history.filter(item => !touches(item, removedKeys));
          for (const key of removedProjects) delete value.metadata[digest(key)];
          for (const key of Object.keys(value.metadata)) {
            const item = value.metadata[key];
            if (Array.isArray(item)) value.metadata[key] = item.filter(entry => !touches(entry, removedKeys));
            else if (item && typeof item === 'object') for (const entry of Object.keys(item)) {
              if (removedKeys.has(entry) || touches(item[entry], removedKeys)) delete item[entry];
            }
          }
          for (const key of ['requests', 'lightOutbox', 'grants']) {
            const entries = persistence.read(key) ?? {};
            persistence.write(key, Object.fromEntries(Object.entries(entries).filter(([, entry]) => !touches(entry, removedKeys))));
          }
          const preferences = persistence.read('lightPanelPreferences');
          if (preferences) {
            if (removedKeys.has(preferences.selected)) preferences.selected = '';
            for (const key of ['focus', 'collapsed']) preferences[key] = preferences[key].filter(item => !removedKeys.has(item));
            for (const key of Object.keys(preferences.scroll)) if ([...removedKeys].some(item => key === item || key.endsWith('/' + item))) delete preferences.scroll[key];
            persistence.write('lightPanelPreferences', preferences);
          }
          if (snapshot.uiPreferences) {
            const prefs = snapshot.uiPreferences;
            prefs.collapsedKeys = prefs.collapsedKeys.filter(key => !removedKeys.has(key));
            if (removedKeys.has(prefs.selectedStepKey)) prefs.selectedStepKey = null;
            if (removedKeys.has(prefs.focusedRouteKey)) prefs.focusedRouteKey = null;
            for (const key of removedProjects) delete prefs.scrollByProject[key];
          }
          library.archived = library.archived.filter(item => !removedKeys.has(item.key));
          persistence.write('lightDeletedKeys', [...new Set([...(persistence.read('lightDeletedKeys') ?? []), ...removedKeys])]);
        }
        snapshot.revision += 1; snapshot.generatedAt = time; snapshot.date = time.slice(0, 10);
        validateLightSnapshot(snapshot);
        persistence.write('light', value); persistence.write('lightLibrary', library);
        return { saved: true, revision: snapshot.revision };
      });
    },
  };
}
