import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createProbe, loadProbeConfig } from './probe.mjs';

try {
  const config = await loadProbeConfig(process.env.WORKBENCH_PROBE_CONFIG);
  await createProbe(config).connect(new StdioServerTransport());
} catch {
  console.error('Workbench U01 probe failed to start. Check local configuration.');
  process.exitCode = 1;
}
