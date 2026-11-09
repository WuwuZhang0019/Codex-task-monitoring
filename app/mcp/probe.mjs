import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { schemaFor, validatorFor } from './contracts.mjs';
import { UUID } from '../server/validation.mjs';

const TOOL = 'workbench_get_project';
export async function loadProbeConfig(file) {
  if (!file || !path.isAbsolute(file)) throw new Error('PROBE_CONFIG_REQUIRED');
  const config = JSON.parse(await readFile(file, 'utf8'));
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port
    || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password
    || !UUID.test(config.projectId) || typeof config.token !== 'string' || config.token.length < 32) {
    throw new Error('PROBE_CONFIG_INVALID');
  }
  return config;
}

export function createProbe(config) {
  const server = new Server({ name: 'task-workbench-u01-probe', version: '0.1.0' }, { capabilities: { tools: {} } });
  const validateInput = validatorFor(TOOL, 'input');
  const validateOutput = validatorFor(TOOL, 'output');
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
    name: TOOL,
    description: 'U01 isolated project read probe. Only projectId is supported. Read the fixture project named by the local grant.',
    inputSchema: {
      type: 'object', properties: { projectId: { type: 'string', minLength: 1, maxLength: 200 } },
      required: ['projectId'], additionalProperties: false,
    },
    outputSchema: schemaFor(TOOL, 'output'),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    if (request.params.name !== TOOL) throw new McpError(ErrorCode.InvalidParams, 'Unsupported probe tool');
    const args = request.params.arguments;
    if (!validateInput(args) || Object.keys(args).some(key => key !== 'projectId')) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid or unsupported probe arguments');
    }
    const failure = code => {
      const value = {
        schemaVersion: '1.0.0', ruleVersion: 'u01-probe-v1', requestId: randomUUID(),
        status: 'rejected', basisRevision: null, supportedCapabilities: ['project.read.probe'],
        disposition: 'wait_verification', sourceTrust: 'declared', sourceTrustReason: 'No authenticated chat binding',
        error: { code, message: code, retryable: code === 'OWNER_UNAVAILABLE', recovery: 'Check owner and grant, then repeat this read' },
      };
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    };
    if (args.projectId !== config.projectId) return failure('FORBIDDEN');
    try {
      const response = await fetch(`${config.endpoint}/probe/projects/${config.projectId}`, {
        headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(3000), redirect: 'error',
      });
      if (response.status === 403) return failure('FORBIDDEN');
      if (!response.ok) return failure('OWNER_UNAVAILABLE');
      const value = await response.json();
      if (!validateOutput(value) || value.result?.project.projectId !== config.projectId) return failure('OWNER_RESPONSE_INVALID');
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    } catch {
      return failure('OWNER_UNAVAILABLE');
    }
  });
  return server;
}
