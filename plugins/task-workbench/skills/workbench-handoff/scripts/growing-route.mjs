// 日期：2026-11-16。为实际明确的新步骤生成可恢复修订；重试复用固定业务键。
import {readFile, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {sha256} from './normalize-plan.mjs';
import {stepInScope} from './step-scope.mjs';

function requireValue(value, code) { if (!value) throw Error(code); }

export function buildGrowingRouteRevision(snapshot, options) {
  requireValue(snapshot?.mode === 'service', 'SERVICE_SNAPSHOT_REQUIRED');
  const plan = snapshot.plans.find(item => item.id === options.planId);
  const project = snapshot.projects.find(item => item.key === plan?.projectKey);
  const heading = snapshot.steps.find(item => item.key === options.headingKey && item.planKey === plan?.key);
  requireValue(project?.id && Number.isSafeInteger(project.revision) && heading, 'EXACT_HEADING_REQUIRED');
  requireValue(snapshot.routes.some(route => route.planKey === plan.key && stepInScope(snapshot.steps, heading.key, route.stepKeys)), 'HEADING_ROUTE_REQUIRED');
  requireValue(options.taskKey?.trim() || options.existingStepKey?.trim(), 'STABLE_TASK_KEY_REQUIRED');
  const key = options.existingStepKey ?? heading.key + '/work/' + sha256(options.taskKey).slice(0, 24);
  let step = snapshot.steps.find(item => item.key === key);
  requireValue(!options.existingStepKey || step, 'EXISTING_STEP_NOT_FOUND');
  requireValue(!step || step.parentKey === heading.key && step.planKey === plan.key, 'TASK_IDENTITY_CONFLICT');
  const created = !step;
  if (created) {
    requireValue(options.title?.trim() && options.acceptance?.trim() && options.sourceLocator?.trim(), 'ACTUAL_STEP_DESCRIPTION_REQUIRED');
    const children = snapshot.steps.filter(item => item.parentKey === heading.key);
    const used = new Set(children.map(item => item.code));
    let number = Math.max(0, ...children.map(item => Number(item.code.slice(heading.code.length + 1)) || 0)) + 1;
    while (used.has(heading.code + '-' + String(number).padStart(2, '0'))) number++;
    const dependsOn = [...new Set(options.dependsOn ?? [])];
    requireValue(dependsOn.every(key => snapshot.steps.some(item => item.key === key && item.planKey === plan.key)), 'DEPENDENCY_NOT_FOUND');
    requireValue(!dependsOn.includes(heading.key), 'PARENT_IS_NOT_A_COMPLETION_DEPENDENCY');
    const time = options.occurredAt ?? new Date().toISOString();
    step = {key, id:null, projectKey:project.key, planKey:plan.key, parentKey:heading.key,
      code:heading.code + '-' + String(number).padStart(2, '0'), originalCode:null,
      title:options.title, sourceLocator:options.sourceLocator, order:Math.max(0, ...children.map(item => item.order)) + 1,
      required:true, dependsOn, status:'pending', acceptance:'pending', sync:'pendingSync',
      conditions:[{conditionId:key + '/exit', text:options.acceptance, required:true, result:'pending', evidenceIds:[]}],
      evidence:[], blockers:[], bindingKey:null, executionKey:null, updatedAt:time};
  }
  // 调试、重试不修订结构，调用者使用原 stepId/绑定/执行更新状态。
  if (!created && !options.history) return {outcome:'reused', stepKey:key, stepId:step.id, request:null};
  requireValue(options.eventId?.trim() && options.reason?.trim(), 'EVENT_AND_REASON_REQUIRED');
  const candidate = structuredClone(snapshot);
  candidate.mode = 'local'; candidate.revision = null;
  candidate.projects = [{...project, id:null, revision:null, planKeys:[plan.key]}];
  candidate.plans = [{...structuredClone(plan), id:null}];
  candidate.steps = snapshot.steps.filter(item => item.planKey === plan.key).map(item => ({...structuredClone(item), id:null, bindingKey:null, executionKey:null}));
  if (created) {
    candidate.steps.push(step);
    // 候选先容纳新子项；领域修订保留原完成历史并执行真实复核失效。
    for (const parent of candidate.steps.filter(item => stepInScope(candidate.steps, heading.key, [item.key]))) {
      if (parent.status === 'completed') { parent.status = 'blocked'; parent.acceptance = 'recheck'; }
    }
  }
  candidate.routes = snapshot.routes.filter(item => item.planKey === plan.key).map(item => ({...structuredClone(item), id:null}));
  for (const group of ['bindings', 'executions', 'supplements', 'events']) candidate[group] = [];
  candidate.uiPreferences = {collapsedKeys:[], selectedStepKey:null, focusedRouteKey:null, scrollByProject:{}};
  const {trust, ...source} = plan.source;
  const request = {schemaVersion:'light-1.0', projectId:project.id, planId:plan.id, expectedRevision:project.revision,
    eventId:options.eventId, occurredAt:options.occurredAt ?? new Date().toISOString(), reason:options.reason,
    source, snapshot:candidate, confirmationGrant:null};
  if (options.history) {
    requireValue(['pending','completed'].includes(options.history.status), 'HISTORY_STATUS_REQUIRED');
    requireValue(options.history.status !== 'completed' || options.history.checks || step.conditions.length === 1, 'EXPLICIT_HISTORY_CHECKS_REQUIRED');
    const proofs = structuredClone(options.history.evidence ?? []);
    const checks = options.history.checks ?? step.conditions.map(item => ({...item,
      result: options.history.status === 'completed' ? 'passed' : 'pending', evidenceIds:proofs.map(proof => proof.evidenceId)}));
    request.historicalSteps = [{stepKey:key, status:options.history.status, occurredAt:options.history.occurredAt ?? null, checks, evidence:proofs}];
  }
  return {outcome:created ? 'created' : 'history', stepKey:key, stepId:step.id, request};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [snapshotFile, optionsFile, output] = process.argv.slice(2);
  requireValue(snapshotFile && optionsFile && output, 'Usage: node growing-route.mjs <service-snapshot.json> <options.json> <request.json>');
  const result = buildGrowingRouteRevision(JSON.parse(await readFile(snapshotFile, 'utf8')), JSON.parse(await readFile(optionsFile, 'utf8')));
  if (result.request) await writeFile(output, JSON.stringify(result.request, null, 2) + '\n', {encoding:'utf8', flag:'wx'});
  console.log(JSON.stringify({outcome:result.outcome, stepKey:result.stepKey, stepId:result.stepId, output:result.request ? output : null}));
}
