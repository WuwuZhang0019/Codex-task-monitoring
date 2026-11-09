import path from 'node:path';
import os from 'node:os';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createProbe, loadProbeConfig } from './probe.mjs';

try {
  const file = process.env.WORKBENCH_PROBE_CONFIG ?? path.join(os.homedir(), '.codex', 'task-workbench-u01', 'probe-config.json');
  const config = await loadProbeConfig(file);
  await createProbe(config).connect(new StdioServerTransport());
} catch {
  console.error('Workbench U01 plugin probe failed to start. Check the local grant and owner.');
  process.exitCode = 1;
}
