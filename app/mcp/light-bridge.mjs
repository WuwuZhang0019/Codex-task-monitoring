// Date: 2026-11-16. Recover the installed island and reconcile original events before resuming.
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { lightTools, validateLightToolArguments } from './light.mjs';
import { discoverOwner } from '../desktop/client.mjs';
import { preparePrivateDirectory, writePrivateJson } from '../desktop/private-runtime.mjs';
import { liveUpdateProtocol } from '../desktop/runtime-protocol.mjs';

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
const operationOf = { workbench_register_plan: 'register', workbench_revise_plan: 'revise',
  workbench_reserve_execution: 'reserveExecution', workbench_update_step_status: 'update',
  workbench_record_supplement: 'supplement', workbench_bind_context: 'bind',
  workbench_complete_plan: 'completePlan', workbench_save_coordination: 'coordinate' };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(value).digest('hex');

export function createLightBridge(config, { readTimeoutMs = 5000, writeTimeoutMs = 30000, reloadConfig,
  presenceIntervalMs = 10000, allowOfflineDiscovery = false, appId, recovery, journalDirectory } = {}) {
  const server = new Server({ name: 'task-workbench-light-bridge', version: '0.1.26' }, { capabilities: { tools: {} } });
  const session = randomUUID();
  let heartbeatTimer, heartbeatBusy = false, closed = false;
  const activeProjects = new Set();
  const pending = new Map();
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
    return { endpoint: `${owner.endpoint.replace(/\/$/, '')}/api/light-mcp`, token: current.token,
      ownerGeneration: owner.ownerGeneration, protocol: owner.liveUpdateProtocol };
  }
  async function probe() {
    const current = await connection();
    const response = await fetch(current.endpoint, { headers: headers(current.token),
      signal: AbortSignal.timeout(readTimeoutMs), redirect: 'error' });
    if (response.status === 403) throw Error('FORBIDDEN');
    if (!response.ok) throw Error('OWNER_UNAVAILABLE');
    const value = await response.json();
    if (!Array.isArray(value.tools) || value.tools.length !== lightTools.length
      || new Set(value.tools.map(tool => tool.name)).size !== lightTools.length
      || value.tools.some(tool => !lightTools.some(expected => expected.name === tool.name) || !tool.inputSchema)) throw Error('OWNER_RESPONSE_INVALID');
    return { ...current, tools: value.tools };
  }
  const ready = () => recovery ? recovery.ensure(probe) : connection();
  async function send(current, name, args, readOnly) {
    const response = await fetch(current.endpoint, { method: 'POST',
      headers: { ...headers(current.token), 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: args }),
      signal: AbortSignal.timeout(readOnly ? readTimeoutMs : writeTimeoutMs), redirect: 'error' });
    if (response.status === 403) return failure('FORBIDDEN');
    if (response.status === 400 || response.status === 413) return failure('INVALID_INPUT', false,
      name === 'workbench_get_project' ? 'provideProjectIdOrRegisterPlan' : 'checkArgumentsAgainstToolSchema');
    if (!response.ok) throw Error('OWNER_UNAVAILABLE');
    const result = await response.json();
    if (!Array.isArray(result.content) || !result.structuredContent || typeof result.structuredContent !== 'object') throw Error('OWNER_RESPONSE_INVALID');
    return result;
  }
  function observe(name, args, response) {
    if (response.structuredContent?.status !== 'accepted') return;
    const result = response.structuredContent.result;
    if (name === 'workbench_get_project' && Array.isArray(result?.executions)) {
      if (result.executions.some(item => !item.endedAt && item.outcome === 'running')) activeProjects.add(args.projectId);
      else activeProjects.delete(args.projectId);
    }
    if (name === 'workbench_update_step_status' && args.targetStatus === 'running') activeProjects.add(args.projectId);
    if (name === 'workbench_complete_plan') activeProjects.delete(args.projectId);
  }
  async function heartbeat(offline = false) {
    if (heartbeatBusy && !offline) return;
    heartbeatBusy = true;
    try {
      const current = !offline && activeProjects.size ? await ready() : await connection();
      await fetch(current.endpoint, { headers: headers(current.token, offline), signal: AbortSignal.timeout(readTimeoutMs), redirect: 'error' });
      if (!offline && !closed) for (const projectId of [...activeProjects]) {
        observe('workbench_get_project', { projectId }, await send(current, 'workbench_get_project', { projectId }, true));
      }
    } catch { /* Retain execution identities through an outage; never dispatch business work here. */ }
    finally { heartbeatBusy = false; }
  }
  server.oninitialized = () => {
    if (!appId && !/codex/i.test(server.getClientVersion()?.name ?? '')) return;
    void heartbeat();
    heartbeatTimer = setInterval(() => { void heartbeat(); }, presenceIntervalMs);
    heartbeatTimer.unref?.();
  };
  server.onclose = () => { closed = true; if (heartbeatTimer) { clearInterval(heartbeatTimer); void heartbeat(true); } };
  const toolsByName = new Map(lightTools.map(tool => [tool.name, tool]));
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try { return { tools: (await probe()).tools }; }
    catch (error) {
      // Discovery stays available offline. Launch only on an authorized tool call or active recovery.
      if (allowOfflineDiscovery && !['FORBIDDEN', 'OWNER_RESPONSE_INVALID'].includes(error.message)) return { tools: structuredClone(lightTools) };
      throw new McpError(ErrorCode.InternalError, 'OWNER_UNAVAILABLE');
    }
  });
  async function journal(current, name, args) {
    const key = hash(JSON.stringify([current.token, name, args.projectId ?? args.snapshot?.projects?.[0]?.key, args.eventId]));
    const file = journalDirectory ? path.join(journalDirectory, `${key}.json`) : null;
    let old = pending.get(key);
    if (!old && file) {
      try { old = JSON.parse(await readFile(file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw Error('RECOVERY_REQUIRED'); }
    }
    const request = JSON.stringify({ name, arguments: args });
    if (old && JSON.stringify(canonical(JSON.parse(old.request))) !== JSON.stringify(canonical({ name, arguments: args }))) throw Error('IDEMPOTENCY_CONFLICT');
    return { key, file, old, value: { version: 1, request, query: { projectId: args.projectId ?? args.snapshot?.projects?.[0]?.key,
      operation: operationOf[name], eventId: args.eventId } } };
  }
  async function save(entry) {
    if (entry.file) { await preparePrivateDirectory(journalDirectory); await writePrivateJson(entry.file, entry.value); }
    pending.set(entry.key, entry.value);
  }
  async function clear(entry) {
    if (entry.file) await unlink(entry.file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    pending.delete(entry.key);
  }
  async function reconcile(current, entry) {
    const response = await send(current, 'workbench_query_event', entry.value.query, true);
    const value = response.structuredContent;
    if (value.status !== 'accepted') return response;
    if (value.result?.state === 'unknown') return null;
    if (value.result?.state !== 'committed') return failure('UNKNOWN_RESULT', true);
    const accepted = { ...value, result: value.result.result };
    return { content: [{ type: 'text', text: JSON.stringify(accepted) }], structuredContent: accepted };
  }
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params;
    const tool = toolsByName.get(name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, 'Unsupported workbench tool');
    const issues = validateLightToolArguments(name, args);
    if (issues.length) return failure('INVALID_INPUT', false, name === 'workbench_get_project' ? 'provideProjectIdOrRegisterPlan' : 'fixValidationErrorsAndRetry', issues);
    let current;
    try { current = await ready(); }
    catch (error) { return failure(error.message === 'FORBIDDEN' ? 'FORBIDDEN' : 'OWNER_UNAVAILABLE', false,
      /^ISLAND_/.test(error.message) ? error.message : 'restoreIslandAndRetryOriginalRequest'); }
    const readOnly = tool.annotations.readOnlyHint;
    let entry;
    if (recovery && !readOnly) {
      try {
        entry = await journal(current, name, args);
        if (entry.old) {
          const previous = await reconcile(current, entry);
          if (previous) {
            if (previous.structuredContent.status === 'accepted') { await clear(entry); observe(name, args, previous); }
            return previous;
          }
        }
        await save(entry);
      } catch (error) { return failure(error.message === 'IDEMPOTENCY_CONFLICT' ? error.message : 'RECOVERY_REQUIRED', error.message !== 'IDEMPOTENCY_CONFLICT'); }
    }
    try {
      const response = await send(current, name, args, readOnly);
      if (entry && response.structuredContent.status !== 'unknown') await clear(entry);
      observe(name, args, response);
      return response;
    } catch {
      if (recovery) try {
        const prior = current;
        current = await ready();
        let response = readOnly ? await send(current, name, args, true) : await reconcile(current, entry);
        // A confirmed successor holds the exclusive data lease. The prior owner cannot still commit this event.
        if (!response && prior.protocol === liveUpdateProtocol && current.protocol === liveUpdateProtocol
          && prior.ownerGeneration !== current.ownerGeneration && prior.token === current.token) {
          response = await send(current, name, args, false);
        }
        if (response) {
          if (entry && response.structuredContent.status === 'accepted') await clear(entry);
          observe(name, args, response);
          return response;
        }
      } catch { /* Keep the durable original event; an uncertain write is never blindly replayed. */ }
      return readOnly ? failure('OWNER_UNAVAILABLE') : failure('UNKNOWN_RESULT', true);
    }
  });
  return server;
}
