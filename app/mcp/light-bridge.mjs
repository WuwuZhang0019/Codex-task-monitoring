// 更新日期 2026-11-11。STDIO 桥连接已有所有者，凭据来自受控本机配置。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { lightTools, validateLightToolArguments } from './light.mjs';
import { discoverOwner } from '../desktop/client.mjs';

export async function loadLightConfig(file) {
  if (!file || !path.isAbsolute(file)) throw new Error('LIGHT_CONFIG_REQUIRED');
  const config = JSON.parse(await readFile(file, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || typeof config.token !== 'string' || !/^[a-f0-9]{64,}$/i.test(config.token)
    || Object.keys(config).some(key => !['endpoint', 'dataDir', 'token'].includes(key))
    || Object.hasOwn(config, 'endpoint') === Object.hasOwn(config, 'dataDir')) throw new Error('LIGHT_CONFIG_INVALID');
  if (Object.hasOwn(config, 'dataDir')) {
    if (typeof config.dataDir !== 'string' || !path.isAbsolute(config.dataDir)) throw new Error('LIGHT_CONFIG_INVALID');
    return { dataDir: path.resolve(config.dataDir), token: config.token };
  }
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port
    || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) {
    throw new Error('LIGHT_CONFIG_INVALID');
  }
  return { endpoint: endpoint.origin, token: config.token };
}

function failure(code, unknown = false, recovery, validationErrors) {
  const value = { schemaVersion: 'light-1.0', requestId: randomUUID(), status: unknown ? 'unknown' : 'rejected',
    error: { code, message: code, retryable: false,
      recovery: recovery ?? (unknown ? 'queryOriginalEventBeforeRetry' : 'checkOwnerAndGrant'),
      ...(validationErrors?.length ? { validationErrors } : {}) } };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

export function createLightBridge(config, { readTimeoutMs = 5000, writeTimeoutMs = 30000, reloadConfig,
  presenceIntervalMs = 10000, allowOfflineDiscovery = false, appId } = {}) {
  const server = new Server({ name: 'task-workbench-light-bridge', version: '0.1.16' }, { capabilities: { tools: {} } });
  const session = randomUUID();
  let heartbeatTimer, heartbeatBusy = false;
  // Date: 2026-11-12. Only initialized MCP clients renew presence; a running owner is insufficient.
  function headers(token, offline = false) {
    const rawName = server.getClientVersion()?.name;
    const name = typeof rawName === 'string' ? rawName.replace(/[^\x20-\x7e]/g, '_').slice(0,100) : '';
    return { Authorization: `Bearer ${token}`, ...(appId ? { 'X-Workbench-App': appId } : {}), ...(typeof name === 'string' && /^[\x20-\x7e]{1,100}$/.test(name)
      ? { 'X-Workbench-Client': name, 'X-Workbench-Session': session,
        'X-Workbench-Presence': offline ? 'offline' : 'online' } : {}) };
  }
  async function connection() {
    const current = reloadConfig ? await reloadConfig() : config;
    const owner = current.dataDir ? await discoverOwner(current.dataDir) : current;
    return { endpoint: `${owner.endpoint.replace(/\/$/, '')}/api/light-mcp`, token: current.token };
  }
  async function heartbeat(offline = false) {
    if (heartbeatBusy && !offline) return;
    heartbeatBusy = true;
    try {
      const current = await connection();
      await fetch(current.endpoint, { headers: headers(current.token, offline), signal: AbortSignal.timeout(readTimeoutMs), redirect: 'error' });
    } catch { /* A failed lease expires; it never retries a business write. */ }
    finally { heartbeatBusy = false; }
  }
  server.oninitialized = () => {
    if (!appId && !/codex/i.test(server.getClientVersion()?.name ?? '')) return;
    void heartbeat();
    heartbeatTimer = setInterval(() => { void heartbeat(); }, presenceIntervalMs);
    heartbeatTimer.unref?.();
  };
  server.onclose = () => { if (heartbeatTimer) { clearInterval(heartbeatTimer); void heartbeat(true); } };
  const toolsByName = new Map(lightTools.map(tool => [tool.name, tool]));
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const current = await connection();
      const response = await fetch(current.endpoint, { headers: headers(current.token),
        signal: AbortSignal.timeout(readTimeoutMs), redirect: 'error' });
      if (!response.ok) throw new Error('OWNER_UNAVAILABLE');
      const result = await response.json();
      if (!Array.isArray(result.tools) || result.tools.length !== toolsByName.size
        || new Set(result.tools.map(tool => tool.name)).size !== toolsByName.size
        || result.tools.some(tool => !toolsByName.has(tool.name) || !tool.inputSchema)) throw new Error('OWNER_RESPONSE_INVALID');
      return { tools: result.tools };
    } catch (error) {
      // Date: 2026-11-12. A fresh installation can wait for its first desktop connection in the same MCP session.
      if (allowOfflineDiscovery && error.code === 'ENOENT') return { tools: structuredClone(lightTools) };
      throw new McpError(ErrorCode.InternalError, 'OWNER_UNAVAILABLE');
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params;
    const tool = toolsByName.get(name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, 'Unsupported workbench tool');
    const issues = validateLightToolArguments(name, args);
    if (issues.length) return failure('INVALID_INPUT', false, name === 'workbench_get_project' ? 'provideProjectIdOrRegisterPlan' : 'fixValidationErrorsAndRetry', issues);
    const body = JSON.stringify({ name, arguments: args });
    if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new McpError(ErrorCode.InvalidParams, 'Workbench request exceeds 2MB');
    const readOnly = tool.annotations.readOnlyHint;
    try {
      const current = await connection();
      const response = await fetch(current.endpoint, { method: 'POST',
        headers: { ...headers(current.token), 'Content-Type': 'application/json' }, body,
        signal: AbortSignal.timeout(readOnly ? readTimeoutMs : writeTimeoutMs), redirect: 'error' });
      if (response.status === 403) return failure('FORBIDDEN');
      if (response.status === 400 || response.status === 413) return failure('INVALID_INPUT', false,
        request.params.name === 'workbench_get_project' ? 'provideProjectIdOrRegisterPlan' : 'checkArgumentsAgainstToolSchema');
      if (!response.ok) throw new Error('OWNER_UNAVAILABLE');
      const result = await response.json();
      if (!Array.isArray(result.content) || !result.structuredContent || typeof result.structuredContent !== 'object') {
        throw new Error('OWNER_RESPONSE_INVALID');
      }
      return result;
    } catch {
      // 写请求可能已提交。桥保持原请求不重发，由调用者查询原事件。
      return readOnly ? failure('OWNER_UNAVAILABLE') : failure('UNKNOWN_RESULT', true);
    }
  });
  return server;
}
