// Date: 2026-11-12. Owner-only route archival and transactional deletion.
import { digest } from './receipts.mjs';
import { lightError, validateLightSnapshot } from './light-model.mjs';

export function touches(value, keys) {
  if (typeof value === 'string') return keys.has(value);
  if (Array.isArray(value)) return value.some(item => touches(item, keys));
  return value && typeof value === 'object' && Object.entries(value).some(([key, item]) => keys.has(key) || touches(item, keys));
}

export function createLightLibrary(persistence) {
  return {
    change(action, input) {
      return persistence.run(() => {
        if (!['archive', 'restore', 'delete'].includes(action) || !input || input.acknowledged !== true
          || Object.keys(input).sort().join(',') !== 'acknowledged,expectedRevision,key'
          || typeof input.key !== 'string' || !input.key || !Number.isSafeInteger(input.expectedRevision)) {
          lightError('INVALID_INPUT', '需要条目、版本和明确确认');
        }
        const value = persistence.read('light'), snapshot = value?.snapshot;
        if (!snapshot) lightError('NOT_FOUND', '任务不存在', 404);
        if (snapshot.revision !== input.expectedRevision) lightError('REVISION_CONFLICT', '任务已更新，请刷新后重试', 409);
        const route = snapshot.routes.find(item => item.key === input.key);
        const plan = snapshot.plans.find(item => item.key === (route?.planKey ?? input.key));
        const project = snapshot.projects.find(item => item.key === (plan?.projectKey ?? input.key));
        if (!project || (!route && plan && snapshot.routes.some(item => item.planKey === plan.key))
          || (!route && !plan && snapshot.plans.some(item => item.projectKey === project.key))) {
          lightError('NOT_FOUND', '列表条目不存在', 404);
        }
        const library = persistence.read('lightLibrary') ?? { version: 1, archived: [] };
        const archived = library.archived.find(item => item.key === input.key);
        const time = new Date().toISOString();
        if (action === 'archive') {
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
