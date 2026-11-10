// 日期：2026-11-10。U03 固定输入的生产界面与真实 HTTP 验证。
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from '../server/index.mjs';
import { draftInput, workContext, actorDeclaration } from './helpers/u03-fixture.mjs';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(app, 'test-results/manual-trial/U03-EX01');
await mkdir(output, { recursive: true });
const dataDir = await mkdtemp(path.join(output, 'ui-data-'));
const input = draftInput(); input.candidate.goal = null;
const inputFile = path.join(output, 'ui-fixed-input.json'); await writeFile(inputFile, JSON.stringify(input, null, 2));
const server = await createServer({ dataDir, env: {} });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const checks = [];
async function check(label, run) { await run(); checks.push({ label, result: 'passed' }); console.log('PASS', label); }
async function api(endpoint, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(base + '/api' + endpoint, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  assert.ok(response.ok, await response.clone().text()); return response.json();
}
try {
  await page.goto(base);
  await page.getByRole('button', { name: '方案草稿与集中确认', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await check('上传一次结构化草稿，集中显示缺项', async () => {
    await dialog.locator('input[type=file]').setInputFiles(inputFile);
    await dialog.getByRole('button', { name: '保存草稿与修订', exact: true }).click();
    await dialog.getByText('集中问题', { exact: true }).waitFor();
    assert.match(await dialog.textContent(), /缺少必需内容/);
    await dialog.screenshot({ path: path.join(output, 'ui-draft-issues.png') });
  });
  await check('补缺后保存，未保存改动禁止校验', async () => {
    await dialog.getByLabel('草稿当前目标', { exact: true }).fill('完成固定业务路线');
    assert.equal(await dialog.getByRole('button', { name: '校验与查看差异', exact: true }).isDisabled(), true);
    await dialog.getByRole('button', { name: '保存草稿与修订', exact: true }).click();
    await dialog.getByRole('button', { name: '校验与查看差异', exact: true }).click();
    await dialog.getByRole('heading', { name: '发布差异', exact: true }).waitFor();
    await dialog.getByLabel('确认草稿覆盖与差异').check();
    await dialog.screenshot({ path: path.join(output, 'ui-draft-confirmation.png') });
  });
  await check('确认后一次发布完整八站，监测保持待绑定', async () => {
    await dialog.getByRole('button', { name: '确认发布完整路线', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.locator('[data-testid^=monitor-]').first().waitFor();
    assert.equal(await page.locator('[data-testid^=monitor-]').count(), 8);
    assert.equal(await page.locator('[data-testid^=monitor-][data-color=dark]').count(), 8);
    await page.screenshot({ path: path.join(output, 'ui-published-route.png'), fullPage: true });
  });
  const { projects } = await api('/projects'), projectId = projects[0].id;
  let model = await api(`/projects/${projectId}/model`);
  const station = model.model.stations[0], task = model.model.tasks[0];
  model.model.chats = [{ id: 'ui-fixed-chat', taskId: task.id, folderId: task.folderId, externalId: 'U03 固定输入聊天声明' }];
  await api(`/projects/${projectId}/model`, model, 'PUT');
  async function command(operation, body) { const value = await api(`/projects/${projectId}/model`); return api(`/projects/${projectId}/business`, { operation, expectedRevision: value.revision, idempotencyKey: crypto.randomUUID(), ...body }); }
  const { binding } = await command('bind', { taskId: task.id, stationId: station.id, sourceId: 'ui-fixed-chat', provider: 'fixture', hostId: 'fixture', dataRootId: 'fixture', sessionId: 'fixture-chat', threadId: null, confirmationRef: 'U03 固定输入人工确认', workContext });
  const scope = { projectId, folderId: task.folderId, taskId: task.id, stationId: station.id, planId: station.planId, sourceId: binding.sourceId, bindingId: binding.bindingId, bindingRevision: binding.bindingRevision, executionId: 'not-started' };
  await command('claim', { scope, workContext, allowedPaths: [], reason: '固定认领' });
  const start = await command('start', { schemaVersion: '1.0.0', projectId, actorDeclaration, scope, workContext, startedAt: '2026-11-10T04:00:00Z', evidence: '固定开始证据' });
  scope.executionId = start.executionId;
  await command('receipt', { schemaVersion: '1.0.0', projectId, actorDeclaration, scope, workContext, deliveryVersion: 'ui-v1', actual: '首次固定交付', raw: '首次固定输入回执', checks: [], evidence: [], unresolved: ['原条件未满足'], endedAt: '2026-11-10T04:01:00Z', outcome: 'failed', next: [] });
  model = await api(`/projects/${projectId}/model`);
  await command('repair', { schemaVersion: '1.0.0', projectId, actorDeclaration, scope, action: 'createCase', case: { triggerReceiptId: null, failedConditionIds: ['k1'], problem: '固定原条件缺口', expectedResult: '按原条件返回', scopeClass: 'requiredRepair', closeConditions: ['k1'], returnAnchor: { projectId, taskId: task.id, stationId: station.id, planId: station.planId, conditionIds: ['k1'], dependencyStationIds: [], successorStationIds: [], mergeStationIds: [], basisRevision: model.revision } } });
  await check('修复与原目标、原条件、回归和等待同屏可查', async () => {
    await page.getByRole('button', { name: '刷新监测', exact: true }).click();
    await page.getByTestId(`monitor-${station.id}`).click();
    const panel = page.getByRole('region', { name: '业务上下文与修复回归' });
    await panel.getByText('固定原条件缺口 · 处理中', { exact: true }).waitFor();
    assert.match(await panel.textContent(), /完成本站1/); assert.match(await panel.textContent(), /回归位置/); assert.match(await panel.textContent(), /等待对象/);
    await panel.screenshot({ path: path.join(output, 'ui-repair-return.png') });
  });
  await check('保存重开后草稿发布与修复记录仍在', async () => {
    const disk = JSON.parse(await readFile(path.join(dataDir, 'aggregate.json'), 'utf8'));
    assert.equal(disk.models[projectId].model.business.repairs.length, 1);
    assert.equal(Object.values(disk.drafts)[0].status, 'committed');
    await page.reload(); await page.getByTestId(`monitor-${station.id}`).click();
    await page.getByText('固定原条件缺口 · 处理中', { exact: true }).waitFor();
  });
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'ui-summary.json'), JSON.stringify({ date: '2026-11-10', dataDir, projectId, browserVersion: browser.version(), checks, errors }, null, 2));
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
