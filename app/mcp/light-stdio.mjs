// 日期 2026-11-10。stdout 仅供 MCP 协议，桥不会启动或恢复领域所有者。
import path from 'node:path';
import os from 'node:os';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLightBridge, loadLightConfig } from './light-bridge.mjs';

try {
  const file = process.env.WORKBENCH_LIGHT_CONFIG ?? path.join(os.homedir(), '.codex', 'task-workbench-light', 'config.json');
  const config = await loadLightConfig(file);
  await createLightBridge(config, { reloadConfig: () => loadLightConfig(file) }).connect(new StdioServerTransport());
} catch {
  console.error('Workbench light bridge failed to start. Check the private owner configuration.');
  process.exitCode = 1;
}
