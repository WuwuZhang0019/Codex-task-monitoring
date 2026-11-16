// Date: 2026-11-16. stdout is MCP-only; recovery uses the registered native island entry.
import path from 'node:path';
import os from 'node:os';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLightBridge, loadLightConfig } from './light-bridge.mjs';
import { createIslandRecovery } from '../desktop/island-launcher.mjs';
import { validAppId } from '../server/light-apps.mjs';

try {
  const appId = process.env.WORKBENCH_LIGHT_APP ?? 'codex';
  if (!validAppId(appId)) throw new Error('INVALID_APP_ID');
  const directory = path.join(os.homedir(), '.codex', 'task-workbench-light');
  const file = process.env.WORKBENCH_LIGHT_CONFIG ?? (appId === 'codex' ? path.join(directory, 'config.json')
    : path.join(directory, 'connections', appId, 'config.json'));
  if (!file || !path.isAbsolute(file)) throw new Error('LIGHT_CONFIG_REQUIRED');
  let config;
  try { config = await loadLightConfig(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const recovery = config?.endpoint ? undefined : createIslandRecovery({ file: process.env.WORKBENCH_ISLAND_LAUNCHER ?? path.join(directory, 'launcher.json'), dataDir: config?.dataDir });
  await createLightBridge(config, { reloadConfig: () => loadLightConfig(file), allowOfflineDiscovery: true, appId, recovery,
    journalDirectory: path.join(path.dirname(file), 'recovery-events') }).connect(new StdioServerTransport());
} catch {
  console.error('Workbench light bridge failed to start. Check the private owner configuration.');
  process.exitCode = 1;
}
