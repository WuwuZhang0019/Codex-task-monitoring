// 日期 2026-11-10。MCP 仅消费已认证所有者注入的服务和确认入口。
import { randomUUID } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import contract from './contracts/light-v1.json' with { type: 'json' };

const string = { type: 'string', minLength: 1, maxLength: 2000 };
const ref = name => ({ $ref: `#/$defs/${name}` });
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const base = {
  schemaVersion: { const: 'light-1.0' }, projectId: string, planId: string,
  expectedRevision: { type: 'integer', minimum: 0 }, eventId: string,
  source: ref('sourceDeclaration'), occurredAt: string, reason: string,
};
const definitions = {
  workbench_get_project: { read: true, operation: 'read', schema: object({ projectId: { ...string, description: 'A real service project ID or a persisted local projectKey. If none exists yet, register the user plan first; do not pass an empty ID or a Codex sidebar ID.' } }) },
  workbench_register_plan: { operation: 'register', gate: 'publish', schema: object({
    schemaVersion: base.schemaVersion, expectedRevision: { const: 0 }, eventId: string,
    source: ref('sourceDeclaration'), occurredAt: string, snapshot: ref('snapshot'), confirmationGrant: { anyOf: [string, { type: 'null' }] },
  }) },
  workbench_revise_plan: { operation: 'revise', gate: 'publish', schema: object({ ...base, snapshot: ref('snapshot'), confirmationGrant: { anyOf: [string, { type: 'null' }] } }) },
  workbench_reserve_execution: { operation: 'reserveExecutionId', schema: object(base) },
  workbench_update_step_status: { operation: 'update', schema: ref('update') },
  workbench_record_supplement: { operation: 'supplement', schema: ref('supplementWrite') },
  workbench_bind_context: { operation: 'bind', gate: 'bind', schema: ref('bind') },
  workbench_query_event: { read: true, operation: 'query', schema: object({
    projectId: string, operation: { enum: ['register', 'revise', 'reserveExecution', 'update', 'supplement', 'bind', 'acceptBinding', 'completePlan', 'coordinate'] }, eventId: string,
  }) },
  workbench_complete_plan: { operation: 'completePlan', schema: object({ ...base,
    checks: { type: 'array', items: ref('condition') }, evidence: { type: 'array', items: ref('evidence') },
  }) },
  // 日期：2026-11-12。协调检查点不授予宿主权限或业务开始许可。
  workbench_get_coordination: { read: true, operation: 'readCoordination', schema: object({ projectId: string, planId: string, coordinationId: string }) },
  workbench_save_coordination: { operation: 'saveCoordination', schema: object({ ...base, coordinationId: string,
    expectedCheckpointRevision: { type: 'integer', minimum: 0 }, state: { type: 'object', additionalProperties: true } }) },
};

export const lightTools = Object.entries(definitions).map(([name, definition]) => {
  // 根内嵌完整 defs，宿主无需解析外部 URL。
  const inputSchema = { ...structuredClone(definition.schema), $defs: structuredClone(contract.$defs) };
  if (inputSchema.$ref) {
    Object.assign(inputSchema, inputSchema.$defs[inputSchema.$ref.split('/').at(-1)]);
    delete inputSchema.$ref;
  }
  const needed = new Set();
  function collect(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.$ref === 'string' && value.$ref.startsWith('#/$defs/')) {
      const key = value.$ref.slice('#/$defs/'.length);
      if (!needed.has(key)) { needed.add(key); collect(inputSchema.$defs[key]); }
    }
    for (const [key, child] of Object.entries(value)) if (key !== '$defs') collect(child);
  }
  collect(inputSchema);
  inputSchema.$defs = Object.fromEntries([...needed].map(key => [key, inputSchema.$defs[key]]));
  const bindingHelp = name === 'workbench_bind_context' ? ' Automatic desktop mode verifies the project directory (and Git when present) and returns state=confirmed from propose; reuse that binding directly. For a non-Git directory use branch=null and head=null; no git init is needed. For takeover, confirm with confirmationGrant=null. Legacy scoped grants still require confirmation.' : '';
  const registrationHelp = ['workbench_register_plan', 'workbench_revise_plan'].includes(name) ? ' Automatic desktop connection accepts confirmationGrant=null without a private desktop confirmation call. For first registration supply a local snapshot with all service IDs null; the response creates projectId and planIds. No existing project ID or Codex sidebar project is needed. Legacy scoped connections require a valid confirmation grant.' : '';
  return { name, description: `Light workbench ${definition.operation}. Requires an authenticated owner grant.${bindingHelp}${registrationHelp}`, inputSchema,
    annotations: { readOnlyHint: !!definition.read, destructiveHint: !definition.read, idempotentHint: true, openWorldHint: false } };
});
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false });
const validators = new Map(lightTools.map(tool => [tool.name, ajv.compile(tool.inputSchema)]));
// 日期：2026-11-13。仅报告字段路径及约束，不回显请求值或凭据。
export function validateLightToolArguments(name, args) {
  const validate = validators.get(name);
  if (!validate) return [{ path: '/', keyword: 'tool', message: 'Unsupported workbench tool' }];
  if (Buffer.byteLength(JSON.stringify(args ?? null)) > 2 * 1024 * 1024) return [{ path: '/', keyword: 'maxSize', message: 'Request exceeds 2MB' }];
  if (!validate(args)) return validate.errors.slice(0, 40).map(error => ({
    path: error.instancePath + (error.keyword === 'required' ? '/' + error.params.missingProperty : '') || '/',
    keyword: error.keyword, message: error.message,
  }));
  return [ ...(args.snapshot?.plans ?? []).flatMap((plan, i) => plan.source.trust === 'declared' ? [] : [{ path: `/snapshot/plans/${i}/source/trust`, keyword: 'const', message: 'must be declared' }]),
    ...(args.snapshot?.routes ?? []).flatMap((route, i) => route.context.trust === 'declared' ? [] : [{ path: `/snapshot/routes/${i}/context/trust`, keyword: 'const', message: 'must be declared' }]) ];
}
const publicCodes = new Set(['FORBIDDEN', 'NOT_FOUND', 'REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'INVALID_INPUT',
  'STALE_PLAN', 'STALE_BINDING', 'STALE_EXECUTION', 'INVALID_TRANSITION', 'REOPEN_REQUIRED', 'DEPENDENCY_NOT_READY',
  'BLOCKER_NOT_RESOLVED', 'EVIDENCE_MISMATCH', 'CONFIRMATION_REQUIRED', 'UNSUPPORTED_CAPABILITY', 'RECOVERY_REQUIRED',
  'HISTORY_REQUIRED', 'DUPLICATE_ID', 'DUPLICATE_OWNER', 'MISSING_REFERENCE', 'COVERAGE_MISMATCH', 'DEPENDENCY_CYCLE', 'INVALID_IDENTITY']);

// authenticate 在每次调用时重检撤销，不能从 arguments 读取 principal。
// publish/bind 必须由所有者提供，完成确认及事务内门禁后调用领域服务。
// 缺少可信适配器时保留 schema 发现并返回明确的能力缺失。
export function createLightHandler({ service, authenticate = () => null, publish, bind }) {
  const supportedCapabilities = lightTools.filter(tool => !definitions[tool.name].gate
    || typeof ({ publish, bind })[definitions[tool.name].gate] === 'function').map(tool => tool.name);
  async function callTool(request) {
    const { name, arguments: args } = request.params;
    const definition = definitions[name];
    if (!definition || !Object.hasOwn(definitions, name)) throw new McpError(ErrorCode.InvalidParams, 'Unsupported workbench tool');
    const validationErrors = validateLightToolArguments(name, args);
    if (validationErrors.length) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid workbench arguments', { validationErrors });
    }
    let principal;
    try {
      principal = await authenticate();
      if (typeof principal !== 'string' || !principal) throw Object.assign(new Error(), { code: 'FORBIDDEN' });
      let result;
      if (definition.gate) {
        const handler = ({ publish, bind })[definition.gate];
        if (typeof handler !== 'function') throw Object.assign(new Error(), { code: 'UNSUPPORTED_CAPABILITY' });
        result = await handler(principal, definition.operation, structuredClone(args));
      } else if (definition.operation === 'read') result = service.read(principal, args.projectId);
      else if (definition.operation === 'readCoordination') result = service.readCoordination(principal, args);
      else if (definition.operation === 'query') result = service.query(principal, args.projectId, args.operation, args.eventId);
      else result = await service[definition.operation](principal, structuredClone(args));
      const value = { schemaVersion: 'light-1.0', requestId: result.requestId ?? randomUUID(), status: 'accepted',
        supportedCapabilities, result };
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    } catch (error) {
      const candidate = error.code ?? error.message?.split(':')[0];
      const code = publicCodes.has(candidate) ? candidate : 'INTERNAL_ERROR';
      let currentRevision = null;
      if (code === 'REVISION_CONFLICT' && principal) {
        try { currentRevision = service.read(principal, args.projectId).projects.find(project => project.id === args.projectId)?.revision ?? null; }
        catch { /* 当前授权不足时不泄露版本。 */ }
      }
      const unknown = !definition.read && (code === 'INTERNAL_ERROR' || code === 'RECOVERY_REQUIRED');
      const value = { schemaVersion: 'light-1.0', requestId: randomUUID(), status: unknown ? 'unknown' : 'rejected', supportedCapabilities,
        error: { code, message: code, currentRevision, retryable: false,
          recovery: code === 'INTERNAL_ERROR' || code === 'RECOVERY_REQUIRED' ? 'queryOriginalEventBeforeRetry' : 'readAndResolve' } };
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    }
  }
  return { callTool, listTools: async () => ({ tools: structuredClone(lightTools) }) };
}

export function createLightMcp(options) {
  const handler = createLightHandler(options);
  const server = new Server({ name: 'task-workbench-light', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, handler.listTools);
  server.setRequestHandler(CallToolRequestSchema, handler.callTool);
  return server;
}
