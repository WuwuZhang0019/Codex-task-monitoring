// Date: 2026-11-11. Tests load the portable TS contract without service modules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
const bundle = await build({ stdin: { contents: "export * from './protocol'; export * from './fixtures';", resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'ts' }, bundle: true, format: 'esm', platform: 'node', write: false });
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const { createScenario, createSnapshot, validateEnvelope, acceptEnvelope, MockWorkbenchClient, scenarios } = api;

test('all explicit simulation scenarios validate and expose no business write capability', () => {
  for (const { id } of scenarios) {
    const value = validateEnvelope(createScenario(id));
    assert.equal(value.mode, 'simulation');
    assert.equal(value.capabilities.businessWrite, false);
  }
});
test('fixtures cover fixed identity, five states, multiple projects, sixty stages and four linked branches', () => {
  const s = createSnapshot();
  assert.equal(s.projects.length, 3);
  assert.equal(new Set(s.steps.map(x => x.status)).size, 5);
  assert.equal(s.plans.find(x => x.key === 'sim/plan/long').stageKeys.length, 60);
  assert.equal(s.routes.filter(x => x.planKey === 'sim/plan/main').length, 6);
  assert.equal(s.supplements.length, 4);
  assert.ok(s.steps.some(x => x.parentKey));
  assert.ok(s.bindings.length && s.executions.length);
  assert.equal(createScenario('long-route').snapshot.projects.length, 1);
  assert.equal(createScenario('long-route').snapshot.steps.length, 60);
  assert.equal(createScenario('deep-branch').snapshot.supplements.length, 4);
});
test('incompatible headers, malformed display fields and unresolved references fail closed', () => {
  const mutations = [
    e => { e.protocolVersion = 'island-workbench/2'; },
    e => { e.snapshot.steps[0].status = 'done'; },
    e => { e.snapshot.steps[0].dependsOn = ['missing']; },
    e => { e.snapshot.steps[0].title = {}; },
    e => { e.snapshot.routes[0].context.threadId = {}; },
    e => { e.snapshot.bindings[0].context.branch = 3; },
    e => { e.snapshot.plans[0].source.version = null; },
    e => { e.snapshot.events[0].executionKey = 'missing'; },
    e => { e.snapshot.executions[0].bindingKey = 'missing'; },
    e => { e.snapshot.steps[0].key = e.snapshot.steps[1].key; },
    e => { e.capabilities.businessWrite = true; },
    e => { e.snapshot.steps[0].parentKey = e.snapshot.steps[0].key; },
    e => { e.snapshot.supplements[0].linkedPlanKey = e.snapshot.steps[0].planKey; },
    e => { e.snapshot = null; },
  ];
  for (const mutate of mutations) {
    const e = createScenario('multi-project'); mutate(e);
    assert.throws(() => validateEnvelope(e), /INVALID_WORKBENCH_CONTRACT/);
  }
});
test('offline, denial and incompatibility preserve last good snapshot and timestamp without becoming ready', async () => {
  const client = new MockWorkbenchClient();
  const first = await client.read();
  for (const scenario of ['offline', 'unauthorized', 'incompatible']) {
    client.selectScenario(scenario);
    const next = await client.read();
    assert.equal(next.connection.state, scenario);
    assert.deepEqual(next.snapshot, first.snapshot);
    assert.equal(next.connection.lastSuccessAt, first.connection.lastSuccessAt);
  }
  client.selectScenario('multi-project');
  assert.equal((await client.read()).connection.state, 'ready');
});
test('old revision cannot overwrite newer snapshot or last successful read', () => {
  const current = createScenario('multi-project');
  current.snapshot.revision = 22;
  const old = createScenario('multi-project');
  old.snapshot.revision = 21;
  old.snapshot.projects[0].name = 'old';
  const accepted = acceptEnvelope(current, old);
  assert.equal(accepted.snapshot.revision, 22);
  assert.equal(accepted.snapshot.projects[0].name, current.snapshot.projects[0].name);
  assert.equal(accepted.connection.state, 'stale');
});
test('unknown operation remains separate from health and same-key query recovers idempotently', async () => {
  const client = new MockWorkbenchClient('unknown');
  const first = await client.read();
  assert.equal(first.connection.state, 'ready');
  assert.equal(first.connection.healthy, true);
  const key = first.pendingOperation.eventId;
  const a = await client.queryEvent(key);
  const b = await client.queryEvent(key);
  assert.deepEqual(a, b);
  assert.equal(a.state, 'committed');
  assert.equal((await client.read()).pendingOperation, null);
  assert.equal((await client.queryEvent('different-event')).state, 'notFound');
});
test('explicit empty snapshot stays empty; returned reads are defensive copies', async () => {
  const client = new MockWorkbenchClient('empty');
  const empty = await client.read();
  assert.equal(empty.snapshot.projects.length, 0);
  client.selectScenario('multi-project');
  const first = await client.read(); first.snapshot.projects[0].name = 'tampered';
  assert.notEqual((await client.read()).snapshot.projects[0].name, 'tampered');
});
test('service mode requires real identities and cannot implicitly replace simulation', () => {
  const simulation = createScenario('multi-project');
  const service = structuredClone(simulation); service.mode = 'service'; service.snapshot.mode = 'service';
  assert.throws(() => validateEnvelope(service), /fixed id/);
  for (const k of ['projects', 'plans', 'steps', 'routes', 'bindings', 'executions', 'supplements']) for (const x of service.snapshot[k]) x.id = `${x.key}/registered`;
  assert.doesNotThrow(() => validateEnvelope(service));
  assert.throws(() => acceptEnvelope(simulation, service), /mode cannot change/);
});

test('existing light simulation snapshot maps without changing fixed ids or status semantics', async () => {
  const snapshot = JSON.parse(await readFile(new URL('../../src/light-simulation.json', import.meta.url), 'utf8'));
  const envelope = createScenario('multi-project'); envelope.snapshot = snapshot;
  const accepted = validateEnvelope(envelope);
  assert.deepEqual(accepted.snapshot, snapshot);
});
