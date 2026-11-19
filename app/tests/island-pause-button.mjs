// Date: 2026-11-19. Previously released pauses can notify the original chat before it reports running.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const shell = process.env.ISLAND_SHELL_ROOT ?? 'G:/rust/windows-dynamic-island';
const output = path.resolve('test-results/pause-button');
await mkdir(output, { recursive: true });

const bundle = await build({
  stdin: {
    contents: "export { createScenario } from './fixtures'",
    resolveDir: new URL('../contracts/island-workbench-v1/', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const { createScenario } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const snapshot = createScenario('multi-project').snapshot;
snapshot.mode = 'service';
snapshot.revision = 1;
for (const group of ['projects', 'plans', 'steps', 'routes', 'bindings', 'executions', 'supplements']) {
  for (const item of snapshot[group]) item.id = `${item.key}/real`;
}
for (const project of snapshot.projects) project.revision = 1;
// Keep the scenario focused on one active plan. Other fixture plans may share its card.
for (const step of snapshot.steps) {
  if (step.planKey !== snapshot.plans[0].key && step.status === 'running') step.status = 'pending';
}

let preferences = { collapsed: [], selected: snapshot.steps[0].key, focus: [snapshot.routes[0].key], scroll: {}, y: {} };
const libraryCalls = [];

const { preview } = await import(pathToFileURL(path.join(shell, 'node_modules/vite/dist/node/index.js')));
const server = await preview({ root: shell, configFile: false, preview: { host: '127.0.0.1', port: 1499, strictPort: true } });

let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 }, locale: 'zh-CN' });
  page.setDefaultTimeout(8000);
  await page.exposeBinding('pauseBridge', async (_source, command, args) => {
    if (command === 'island_workbench_read') {
      return { snapshot, preferences, continuousRuns: [], continuousSupported: true, library: { version: 1, archived: [] }, librarySupported: true };
    }
    if (command === 'island_workbench_save_preferences') {
      preferences = args.value;
      return { saved: true };
    }
    if (command === 'island_task_library_change') {
      libraryCalls.push(args);
      if (args.action === 'pause') {
        for (const step of snapshot.steps) {
          if (step.planKey === args.value.key && step.status === 'running') {
            step.status = 'blocked';
            step.blockers = [{ blockerId: 'user-pause', reason: '用户在任务岛暂停任务', waitingFor: ['用户继续'], releaseConditions: ['明确继续后恢复原执行'], resolved: false }];
          }
        }
        snapshot.revision += 1;
      }
      return { saved: true, revision: snapshot.revision };
    }
    throw Error('Unexpected command: ' + command);
  });

  await page.goto('http://127.0.0.1:1499');
  await page.locator('[data-workbench-summary]').waitFor();
  await page.evaluate(() => {
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      const result = await window.pauseBridge(command, args);
      if (command === 'island_workbench_read') window.resumeFixtureRevision = result.snapshot.revision;
      return result;
    } };
  });
  await page.waitForFunction(() => document.querySelector('[data-workbench-summary]')?.getAttribute('data-connection') === 'ready');
  await page.locator('[data-hit]').first().click();
  await page.getByTitle('固定展开', { exact: true }).click();
  await page.waitForTimeout(600);

  const layout = await page.locator('.wb-route-actions').first().evaluate(container => {
    const children = [...container.children].map(el => ({
      className: el.className,
      label: el.getAttribute('aria-label'),
      disabled: el.hasAttribute('disabled'),
      rect: el.getBoundingClientRect(),
    }));
    return children;
  });
  assert.equal(layout.length, 3);
  assert.match(layout[0].className, /wb-continuous/);
  assert.match(layout[1].className, /wb-route-pause/);
  assert.match(layout[2].className, /wb-route-archive/);
  assert.ok(layout[0].rect.y < layout[1].rect.y && layout[1].rect.y < layout[2].rect.y, 'pause button sits vertically between continuous and archive buttons');
  assert.equal(layout[1].disabled, false, 'active task pause button is enabled');

  await page.locator('[data-route-card]').first().screenshot({ path: path.join(output, 'card-with-pause-button.png') });
  const pauseBtn = page.locator('.wb-route-pause').first();
  assert.equal(await pauseBtn.getAttribute('aria-checked'), 'true');
  await pauseBtn.hover({ force: true });
  await page.waitForTimeout(400);
  await page.locator('[data-route-card]').first().screenshot({ path: path.join(output, 'card-pause-hover.png') });

  await pauseBtn.click();
  await page.waitForFunction(() => {
    const button = document.querySelector('.wb-route-pause');
    return button?.getAttribute('aria-checked') === 'false' && !button.hasAttribute('disabled');
  });
  assert.equal(libraryCalls.length, 1);
  assert.equal(libraryCalls[0].action, 'pause');
  assert.equal(libraryCalls[0].value.acknowledged, true);
  await page.getByText(/已暂停：/).waitFor();
  await page.locator('[data-route-card]').first().screenshot({ path: path.join(output, 'card-after-pause.png') });
  for (const step of snapshot.steps) {
    const blocker = step.blockers.find(item => item.blockerId === 'user-pause');
    if (blocker) blocker.resolved = true;
  }
  snapshot.revision += 1;
  await page.waitForFunction(() => window.resumeFixtureRevision === 3);
  assert.match(await pauseBtn.getAttribute('title'), /^继续：/);
  await pauseBtn.press('Space');
  await page.getByText(/已通知原 Codex 聊天/).waitFor();
  assert.equal(await pauseBtn.getAttribute('aria-checked'), 'false');
  assert.deepEqual(libraryCalls.map(call => call.action), ['pause', 'resume']);
  assert.equal(libraryCalls[1].value.key, libraryCalls[0].value.key);
  assert.equal(libraryCalls[1].value.expectedRevision, 3);
  for (const step of snapshot.steps) {
    if (step.planKey === libraryCalls[1].value.key && step.blockers.some(item => item.blockerId === 'user-pause' && item.resolved)) {
      step.status = 'running';
    }
  }
  snapshot.revision += 1;
  await page.waitForFunction(() => document.querySelector('.wb-route-pause')?.getAttribute('aria-checked') === 'true');
  assert.equal(await page.getByText('请在原 Codex 聊天发送「继续」或点击继续').count(), 0);
  console.log(JSON.stringify({ passed: true, libraryCalls }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
