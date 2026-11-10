// 日期 2026-11-10。A 阶段结构与样例检查，业务运行验收按 B/D/E 执行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import contract from './contracts/light-v1.json' with { type: 'json' };
import { planSteps } from '../server/plan-steps.mjs';

const schema = structuredClone(contract);
for (const key of Object.keys(schema).filter(key => key.startsWith('x-'))) delete schema[key];
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false });
ajv.addSchema(schema);
const validate = name => ajv.getSchema(`${schema.$id}#/$defs/${name}`);
const snapshotUrl = new URL('../../docs/03_轻量路线工作台/06_执行记录/A_本地快照_2026-11-10.json', import.meta.url);
const snapshot = JSON.parse(await readFile(snapshotUrl, 'utf8'));

// Cross-record assertions validate the frozen fixture. B owns the runtime graph validator.
function checkSnapshot(value) {
  const shape = validate('snapshot');
  assert.equal(shape(value), true, JSON.stringify(shape.errors));
  const groups = ['projects', 'plans', 'steps', 'routes', 'bindings', 'executions', 'supplements'];
  const records = groups.flatMap(group => value[group]);
  assert.equal(new Set(records.map(record => record.key)).size, records.length, 'duplicate key');
  const projects = new Map(value.projects.map(record => [record.key, record]));
  const plans = new Map(value.plans.map(record => [record.key, record]));
  const steps = new Map(value.steps.map(record => [record.key, record]));
  const codes = new Set();
  const orders = new Set();
  for (const plan of value.plans) {
    assert.ok(projects.get(plan.projectKey)?.planKeys.includes(plan.key));
    assert.equal(plan.stageCount, plan.stageKeys.length);
    assert.equal(new Set(plan.stageKeys).size, plan.stageCount);
    assert.deepEqual(plan.stageKeys, value.steps.filter(step => step.planKey === plan.key && step.parentKey === null).map(step => step.key));
  }
  for (const step of value.steps) {
    assert.equal(plans.get(step.planKey)?.projectKey, step.projectKey);
    const scope = `${step.planKey}/${step.parentKey ?? 'stages'}`;
    assert.ok(!codes.has(`${scope}/${step.code}`), 'duplicate code');
    assert.ok(!orders.has(`${scope}/${step.order}`), 'duplicate order');
    codes.add(`${scope}/${step.code}`);
    orders.add(`${scope}/${step.order}`);
    if (step.parentKey) {
      const parent = steps.get(step.parentKey);
      assert.equal(parent?.planKey, step.planKey);
      assert.equal(parent.parentKey, null);
      assert.ok(step.code.startsWith(parent.code + '-'));
    }
    assert.equal(new Set(step.dependsOn).size, step.dependsOn.length);
    for (const key of step.dependsOn) assert.equal(steps.get(key)?.planKey, step.planKey, 'missing or foreign dependency');
    if (step.status === 'completed') {
      assert.equal(step.acceptance, 'passed');
      for (const condition of step.conditions.filter(item => item.required)) {
        assert.equal(condition.result, 'passed');
        assert.ok(condition.evidenceIds.length);
        for (const id of condition.evidenceIds) assert.ok(step.evidence.some(item => item.evidenceId === id && item.result === 'passed'));
      }
      assert.ok(!step.blockers.some(item => !item.resolved));
      for (const child of value.steps.filter(item => item.parentKey === step.key && item.required)) {
        assert.equal(child.status, 'completed', 'parent completion requires necessary children');
        assert.equal(child.acceptance, 'passed');
      }
    }
  }
  const active = new Set(), visited = new Set();
  function visit(key) {
    assert.ok(!active.has(key), 'dependency or aggregation cycle');
    if (visited.has(key)) return;
    active.add(key);
    const children = value.steps.filter(step => step.parentKey === key).map(step => step.key);
    for (const next of [...steps.get(key).dependsOn, ...children]) visit(next);
    active.delete(key);
    visited.add(key);
  }
  for (const key of steps.keys()) visit(key);
  for (const route of value.routes) {
    assert.equal(plans.get(route.planKey)?.projectKey, route.projectKey);
    for (const key of route.stepKeys) assert.equal(steps.get(key)?.planKey, route.planKey);
  }
  const bindings = new Map(value.bindings.map(binding => [binding.key, binding]));
  const owners = new Set();
  for (const binding of value.bindings) {
    assert.equal(plans.get(binding.planKey)?.projectKey, binding.projectKey);
    for (const key of binding.stepKeys) {
      assert.equal(steps.get(key)?.planKey, binding.planKey);
      if (binding.state === 'confirmed') {
        assert.ok(!owners.has(key), 'duplicate responsibility');
        owners.add(key);
      }
    }
    if (binding.state === 'confirmed') {
      assert.ok(binding.id && binding.bindingRevision && binding.confirmationRef);
      assert.equal(binding.revokedAt, null);
    }
  }
  for (const execution of value.executions) {
    assert.equal(plans.get(execution.planKey)?.projectKey, execution.projectKey);
    for (const key of execution.stepKeys) assert.equal(steps.get(key)?.planKey, execution.planKey);
    if (execution.bindingKey) assert.equal(bindings.get(execution.bindingKey)?.planKey, execution.planKey);
  }
  assert.equal(new Set(value.events.map(event => event.eventId)).size, value.events.length);
  for (const event of value.events) {
    if (event.stepKey) assert.ok(steps.has(event.stepKey));
    if (event.executionKey) assert.ok(value.executions.some(execution => execution.key === event.executionKey));
  }
  if (value.mode === 'local') {
    assert.equal(value.revision, null);
    assert.ok(records.every(record => record.id === null), 'local service identities stay empty');
  }
}

test('A-03 本地 A—G 与六个细分快照、稳定历史键及依赖可校验', () => {
  checkSnapshot(snapshot);
  assert.equal(snapshot.steps.length, 13);
  assert.deepEqual(snapshot.steps.filter(step => !step.parentKey).map(step => step.code), [...'ABCDEFG']);
  assert.equal(snapshot.steps.find(step => step.code === 'B').key, 'light-workbench-20261110/A-02');
  assert.notEqual(snapshot.steps.find(step => step.code === 'A-02').key, snapshot.steps.find(step => step.code === 'B').key);
  for (const [name, mutate] of [
    ['duplicate key', value => value.steps[1].key = value.steps[0].key],
    ['missing dependency', value => value.steps[1].dependsOn = ['missing']],
    ['cycle', value => value.steps[0].dependsOn = [value.steps[1].key]],
    ['parent cycle', value => value.steps[7].dependsOn = [value.steps[0].key]],
    ['duplicate code', value => value.steps[1].code = 'A'],
    ['bad parent', value => value.steps[7].parentKey = 'missing'],
    ['bad status', value => value.steps[0].status = 'active'],
    ['false completion', value => value.steps[1].status = 'completed'],
    ['parent bypass', value => value.steps[7].status = 'pending'],
    ['fake service id', value => value.steps[0].id = 'pretend-service-id'],
    ['wrong binding scope', value => value.bindings[0].stepKeys = ['missing']],
    ['wrong execution scope', value => value.executions[0].planKey = 'foreign-plan'],
    ['wrong event scope', value => value.events[0].stepKey = 'missing'],
  ]) {
    const value = structuredClone(snapshot);
    mutate(value);
    assert.throws(() => checkSnapshot(value), undefined, name);
  }
});

test('A-03 五状态 25 对转换与同状态进展规则完整', () => {
  const expected = new Set(['pending/running', 'pending/cancelled', 'running/blocked', 'running/completed', 'running/cancelled', 'blocked/running', 'blocked/cancelled', 'completed/pending', 'completed/running', 'cancelled/pending', 'cancelled/running']);
  for (const from of Object.keys(contract['x-transitions'])) {
    for (const to of Object.keys(contract['x-transitions'])) {
      assert.equal(contract['x-transitions'][from].includes(to), expected.has(`${from}/${to}`));
    }
  }
  assert.ok(contract['x-transaction'].indexOf('lookup-event-replay') < contract['x-transaction'].indexOf('check-revision-and-binding'));
});

const { trust: ignoredTrust, ...source } = snapshot.plans[0].source;
const common = { schemaVersion: 'light-1.0', projectId: 'fixture-project', planId: 'fixture-plan', expectedRevision: 4, eventId: 'fixture-event', source, occurredAt: '2026-11-10T21:40:00+08:00' };
const evidence = { evidenceId: 'fixture-proof', location: 'fixture://proof', method: '结构样例', deliveryVersion: 'fixture-v1', result: 'passed' };
const check = { conditionId: 'fixture-condition', text: '结构可校验', required: true, result: 'passed', evidenceIds: [evidence.evidenceId] };
const update = { ...common, stepId: 'fixture-step', executionId: 'fixture-execution', bindingId: 'fixture-binding', bindingRevision: 1, targetStatus: 'completed', reason: '验收完成结构样例', evidence: [evidence], checks: [check], blocker: null, reopen: null, successorImpact: null };

test('A-04 状态事件必填字段、完成证据、阻塞与取消结构', () => {
  const shape = validate('update');
  assert.ok(shape(update), JSON.stringify(shape.errors));
  for (const field of ['eventId', 'expectedRevision', 'source', 'executionId', 'bindingId']) {
    const value = structuredClone(update); delete value[field];
    assert.equal(shape(value), false, field);
  }
  assert.equal(shape({ ...update, sourceTrust: 'hostObserved' }), false);
  assert.equal(shape({ ...update, source: { ...source, trust: 'hostObserved' } }), false);
  assert.equal(shape({ ...update, checks: [] }), false);
  assert.equal(shape({ ...update, checks: [{ ...check, result: 'pending' }] }), false);
  assert.equal(shape({ ...update, evidence: [] }), false);
  assert.equal(shape({ ...update, targetStatus: 'blocked' }), false);
  assert.ok(shape({ ...update, targetStatus: 'blocked', blocker: { blockerId: 'b', reason: '等待', waitingFor: ['外部交付'], releaseConditions: ['交付验收'], resolved: false } }));
  assert.equal(shape({ ...update, targetStatus: 'cancelled' }), false);
  assert.ok(shape({ ...update, targetStatus: 'cancelled', successorImpact: '后继暂停，等待替代承接' }));
});

test('A-04 绑定、补充事项与保存回执结构', () => {
  const bind = { ...common, action: 'propose', stepIds: ['fixture-step'], context: snapshot.routes[0].context, bindingId: null, expectedBindingRevision: null, confirmationGrant: null, reason: '拟定绑定' };
  assert.ok(validate('bind')(bind));
  assert.equal(validate('bind')({ ...bind, action: 'confirm' }), false);
  assert.ok(validate('bind')({ ...bind, action: 'confirm', bindingId: 'b', expectedBindingRevision: 1, confirmationGrant: 'fixture-grant' }));
  const supplement = { ...common, action: 'create', supplementId: null, sourceStepId: 'fixture-step', title: '独立目标', goal: '模拟规划', blocksSource: true, status: 'unconfirmed', linkedPlanId: null, repairId: null, reason: '固定样例', evidence: [] };
  assert.ok(validate('supplementWrite')(supplement));
  assert.equal(validate('supplementWrite')({ ...supplement, action: 'resolve', status: 'completed' }), false);
  const receipt = { schemaVersion: 'light-1.0', eventId: common.eventId, requestId: 'fixture-request', status: 'committed', committedRevision: 5, receivedAt: common.occurredAt, resultRef: 'fixture-result', errorCode: null, recovery: '读取已保存快照' };
  assert.ok(validate('receipt')(receipt));
  assert.equal(validate('receipt')({ ...receipt, committedRevision: null }), false);
  assert.equal(validate('receipt')({ ...receipt, status: 'unknown' }), false);
  assert.ok(validate('receipt')({ ...receipt, status: 'unknown', committedRevision: null, resultRef: null, recovery: '查询原 eventId' }));
});

test('B-01 明确路线表可读取新总纲，旧完整步骤格式继续兼容', async () => {
  const text = await readFile(new URL('../../docs/03_轻量路线工作台/00_执行入口/00_新路线实施总纲与接口决定_2026-11-10.md', import.meta.url), 'utf8');
  assert.deepEqual(planSteps({ source: text }).map(step => step.code), [...'ABCDEFG']);
});
