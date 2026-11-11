// 日期 2026-11-11。主页面桌面接入回归，原生 invoke 采用受控测试替身。
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from '../server/index.mjs';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = await mkdtemp(path.join(os.tmpdir(), 'light-connection-ui-'));
const output = process.env.D_EVIDENCE_DIR || path.join(app, 'test-results/manual-trial/D-EX01');
await mkdir(output, { recursive: true });
const checks = [];
const errors = [];
const fakeToken = 'fixture-token-must-stay-out-of-the-interface';
let server;
let browser;

async function check(name, operation) {
  await operation();
  checks.push({ name, result: 'passed' });
  console.log(`PASS ${name}`);
}

async function openDesktop({ saveFails = false, revokeFails = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ saveFails, revokeFails, fakeToken }) => {
    const state = { calls: [], saveFails, revokeFails };
    window.__lightConnectionTest = state;
    window.__TAURI__ = { core: { invoke: async (command, args) => {
      state.calls.push({ command, args });
      if (command === 'runtime_status') return { dataPath: 'C:\\fixture\\data', needsSetup: false, running: true, migrationPending: false };
      if (command === 'save_light_connection') {
        if (state.saveFails) throw new Error('FIXTURE_SAVE_FAILED');
        return { configPath: 'C:\\fixture\\config.json' };
      }
      if (command !== 'api_request') throw new Error(`Unexpected command ${command}`);
      const responses = {
        '/projects': { projects: [] }, '/health': { ok: true, ai: { configured: false, model: 'fixture' } },
        '/light-access/grants': { principal: 'fixture-principal', token: fakeToken },
        '/light-access/revoke': { principal: 'fixture-principal', revoked: true },
        '/light-access/confirm-publication': { confirmationGrant: 'fixture-publication-confirmation', contentHash: 'fixture-content-hash' },
        '/light-access/confirm-binding': { confirmationGrant: 'fixture-binding-confirmation', observed: { path: 'G:\\fixture', branch: 'main', head: 'fixture-head' } },
        '/light-access/confirm-supplement': { confirmationGrant: 'fixture-supplement-confirmation', operation: 'confirmSupplement' },
      };
      if (args.path === '/light-access/revoke' && state.revokeFails) throw new Error('FIXTURE_REVOKE_FAILED');
      if (!Object.hasOwn(responses, args.path)) throw new Error(`Unexpected path ${args.path}`);
      return { status: 200, data: responses[args.path] };
    } } };
  }, { saveFails, revokeFails, fakeToken });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('heading', { name: '让执行方案，有一条清晰的路线。' }).waitFor();
  await page.getByText('Codex 接入', { exact: true }).click();
  await page.getByLabel('接入聊天固定ID').fill('fixture-thread');
  await page.getByLabel('接入工作树路径').fill('G:\\fixture');
  return page;
}

async function authorize(page) {
  await page.getByLabel('我已核对授权项目、聊天及工作树范围').check();
  await page.getByRole('button', { name: '授权并保存连接' }).click();
}

async function calls(page) {
  return page.evaluate(() => window.__lightConnectionTest.calls);
}

try {
  server = await createServer({ dataDir: data, distDir: path.join(app, 'dist'), env: {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
  const page = await openDesktop();
  await check('连接授权显式核对后才可提交，保存回执仅展示主体和路径', async () => {
    assert.equal(await page.getByRole('button', { name: '授权并保存连接' }).isDisabled(), true);
    await authorize(page);
    await page.getByLabel('接入确认回执').waitFor();
    assert.equal(await page.getByLabel('接入授权主体ID').inputValue(), 'fixture-principal');
    assert.deepEqual(JSON.parse(await page.getByLabel('接入确认回执').inputValue()), {
      principal: 'fixture-principal', configPath: 'C:\\fixture\\config.json',
    });
    const recorded = await calls(page);
    assert.deepEqual(recorded.find(call => call.args?.path === '/light-access/grants').args, {
      path: '/light-access/grants', method: 'POST', body: {
        projectKeys: ['light-workbench-20261110/project'], threadId: 'fixture-thread', hostId: 'local',
        worktreeRoots: ['G:\\fixture'], acknowledged: true,
      },
    });
    assert.deepEqual(recorded.find(call => call.command === 'save_light_connection').args, { token: fakeToken });
    const visibleValues = await page.locator('input,textarea').evaluateAll(nodes => nodes.map(node => node.value).join('\n'));
    assert.equal(visibleValues.includes(fakeToken), false);
    assert.equal((await page.locator('body').innerText()).includes(fakeToken), false);
    assert.equal(recorded.some(call => call.args?.path === '/light-access/revoke'), false);
  });

  const publication = { operation: 'register', input: { schemaVersion: 'light-1.0', eventId: 'fixture-publication', snapshot: { plans: [{ name: '完整原文步骤' }] } } };
  await check('方案确认保持 JSON 内容并使用当前主体，编辑后重新核对', async () => {
    await page.getByLabel('方案确认JSON').fill(JSON.stringify(publication));
    const submit = page.getByRole('button', { name: '签发方案确认' });
    assert.equal(await submit.isDisabled(), true);
    await page.getByLabel('我已核对完整方案内容与修订差异').check();
    await page.getByLabel('方案确认JSON').fill(JSON.stringify(publication, null, 2));
    assert.equal(await submit.isDisabled(), true);
    await page.getByLabel('我已核对完整方案内容与修订差异').check();
    await submit.click();
    await page.waitForFunction(() => document.querySelector('[aria-label="接入确认回执"]')?.value.includes('fixture-publication-confirmation'));
    const recorded = await calls(page);
    assert.deepEqual(recorded.find(call => call.args?.path === '/light-access/confirm-publication').args.body, {
      ...publication, principal: 'fixture-principal', acknowledged: true,
    });
  });

  await check('补充事项确认显式核对，改动内容和主体后必须重新核对', async () => {
    const supplement = { input: { action: 'update', supplementId: 'fixture-supplement', status: 'unplanned' } };
    await page.getByLabel('补充事项确认JSON').fill(JSON.stringify(supplement));
    const submit = page.getByRole('button', { name: '签发事项确认' });
    assert.equal(await submit.isDisabled(), true);
    await page.getByLabel('我已核对补充事项目标、来源及取消承接').check();
    await page.getByLabel('接入授权主体ID').fill('explicit-supplement-principal');
    assert.equal(await submit.isDisabled(), true);
    await page.getByLabel('我已核对补充事项目标、来源及取消承接').check();
    await submit.click();
    await page.waitForFunction(() => document.querySelector('[aria-label="接入确认回执"]')?.value.includes('fixture-supplement-confirmation'));
    assert.deepEqual((await calls(page)).find(call => call.args?.path === '/light-access/confirm-supplement').args.body, { ...supplement, principal: 'explicit-supplement-principal', acknowledged: true });
  });

  const binding = { principal: 'explicit-fixture-principal', input: { schemaVersion: 'light-1.0', action: 'confirm',
    bindingId: 'fixture-binding', expectedBindingRevision: 1, context: { worktreePath: 'G:\\fixture', branch: 'main' } } };
  await check('绑定确认使用 JSON 显式主体，核对后返回仅内存确认资料', async () => {
    await page.getByLabel('绑定确认JSON').fill(JSON.stringify(binding));
    const submit = page.getByRole('button', { name: '签发绑定确认' });
    assert.equal(await submit.isDisabled(), true);
    await page.getByLabel('我已核对绑定步骤、聊天与工作树').check();
    await submit.click();
    await page.waitForFunction(() => document.querySelector('[aria-label="接入确认回执"]')?.value.includes('fixture-binding-confirmation'));
    const recorded = await calls(page);
    assert.deepEqual(recorded.find(call => call.args?.path === '/light-access/confirm-binding').args.body, { ...binding, acknowledged: true });
    await page.reload();
    await page.getByText('Codex 接入', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('接入确认回执').count(), 0);
    assert.equal(await page.getByLabel('接入授权主体ID').inputValue(), '');
  });
  await page.close();

  const failurePage = await openDesktop({ saveFails: true });
  await check('配置保存失败撤销刚签发的授权，界面不展示新主体', async () => {
    await authorize(failurePage);
    await failurePage.getByRole('alert').filter({ hasText: 'FIXTURE_SAVE_FAILED' }).waitFor();
    const recorded = await calls(failurePage);
    const commands = recorded.filter(call => call.command === 'save_light_connection' || call.args?.path?.startsWith('/light-access/'));
    assert.deepEqual(commands.map(call => call.args?.path || call.command), ['/light-access/grants', 'save_light_connection', '/light-access/revoke']);
    assert.deepEqual(commands[2].args.body, { principal: 'fixture-principal', acknowledged: true });
    assert.equal(await failurePage.getByLabel('接入授权主体ID').inputValue(), '');
    assert.equal(await failurePage.getByLabel('接入确认回执').count(), 0);
    assert.equal((await failurePage.locator('body').innerText()).includes(fakeToken), false);
  });
  await failurePage.close();

  const revokeFailurePage = await openDesktop({ saveFails: true, revokeFails: true });
  await check('保存与撤销均失败时明确待核对的主体，保留错误状态', async () => {
    await authorize(revokeFailurePage);
    const alert = revokeFailurePage.getByRole('alert');
    await alert.filter({ hasText: '撤销也未确认' }).waitFor();
    assert.ok((await alert.innerText()).includes('fixture-principal'));
    assert.equal(await revokeFailurePage.getByLabel('接入授权主体ID').inputValue(), '');
    assert.equal(await revokeFailurePage.getByLabel('接入确认回执').count(), 0);
  });
  await revokeFailurePage.close();
  await check('主页面无未处理浏览器异常', async () => assert.deepEqual(errors, []));
  await writeFile(path.join(output, 'light-connection-ui.json'), JSON.stringify({ date: '2026-11-11',
    environment: '正常主页面入口，Chromium 无头，原生 invoke 测试替身，独立临时数据目录', checks, errors }, null, 2), 'utf8');
  console.log(`${checks.length} desktop connection UI checks passed.`);
} finally {
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  await rm(data, { recursive: true, force: true });
}
