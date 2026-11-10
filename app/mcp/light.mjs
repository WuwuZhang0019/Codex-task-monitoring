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
  workbench_get_project: { read: true, operation: 'read', schema: object({ projectId: string }) },
  workbench_register_plan: { operation: 'register', gate: 'publish', schema: object({
    schemaVersion: base.schemaVersion, expectedRevision: { const: 0 }, eventId: string,
    source: ref('sourceDeclaration'), occurredAt: string, snapshot: ref('snapshot'), confirmationGrant: string,
  }) },
  workbench_revise_plan: { operation: 'revise', gate: 'publish', schema: object({ ...base, snapshot: ref('snapshot'), confirmationGrant: string }) },
  workbench_reserve_execution: { operation: 'reserveExecutionId', schema: object(base) },
  workbench_update_step_status: { operation: 'update', schema: ref('update') },
  workbench_record_supplement: { operation: 'supplement', schema: ref('supplementWrite') },
  workbench_bind_context: { operation: 'bind', gate: 'bind', schema: ref('bind') },
  workbench_query_event: { read: true, operation: 'query', schema: object({
    projectId: string, operation: { enum: ['register', 'revise', 'reserveExecution', 'update', 'supplement', 'bind', 'acceptBinding', 'completePlan'] }, eventId: string,
  }) },
  workbench_complete_plan: { operation: 'completePlan', schema: object({ ...base,
    checks: { type: 'array', items: ref('condition') }, evidence: { type: 'array', items: ref('evidence') },
  }) },
};

export const lightTools = Object.entries(definitions).map(([name, definition]) => {
  // 根内嵌完整 defs，宿主无需解析外部 URL。
  const inputSchema = { ...structuredClone(definition.schema), $defs: structuredClone(contract.$defs) };
  if (inputSchema.$ref) {
    Object.assign(inputSchema, inputSchema.$defs[inputSchema.$ref.split('/').at(-1)]);
    delete inputSchema.$ref;
  }
  return { name, description: `Light workbench ${definition.operation}. Requires an authenticated owner grant.`, inputSchema,
    annotations: { readOnlyHint: !!definition.read, destructiveHint: !definition.read, idempotentHint: true, openWorldHint: false } };
});
const ajv = new Ajv2020({ strict: true, strictRequired: false, strictTypes: false });
const validators = new Map(lightTools.map(tool => [tool.name, ajv.compile(tool.inputSchema)]));
const publicCodes = new Set(['FORBIDDEN', 'NOT_FOUND', 'REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'INVALID_INPUT',
  'STALE_PLAN', 'STALE_BINDING', 'STALE_EXECUTION', 'INVALID_TRANSITION', 'REOPEN_REQUIRED', 'DEPENDENCY_NOT_READY',
  'BLOCKER_NOT_RESOLVED', 'EVIDENCE_MISMATCH', 'CONFIRMATION_REQUIRED', 'UNSUPPORTED_CAPABILITY', 'RECOVERY_REQUIRED',
  'HISTORY_REQUIRED', 'DUPLICATE_ID', 'MISSING_REFERENCE', 'COVERAGE_MISMATCH', 'DEPENDENCY_CYCLE', 'INVALID_IDENTITY']);

// authenticate 在每次调用时重检撤销，不能从 arguments 读取 principal。
// publish/bind 必须由所有者提供，完成确认及事务内门禁后调用领域服务。
// 缺少可信适配器时保留 schema 发现并返回明确的能力缺失。
export function createLightMcp({ service, authenticate = () => null, publish, bind }) {
  const server = new Server({ name: 'task-workbench-light', version: '0.1.0' }, { capabilities: { tools: {} } });
  const supportedCapabilities = lightTools.filter(tool => !definitions[tool.name].gate
    || typeof ({ publish, bind })[definitions[tool.name].gate] === 'function').map(tool => tool.name);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: structuredClone(lightTools) }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params;
    const definition = definitions[name];
    if (!definition || !Object.hasOwn(definitions, name)) throw new McpError(ErrorCode.InvalidParams, 'Unsupported workbench tool');
    if (Buffer.byteLength(JSON.stringify(args ?? null)) > 2 * 1024 * 1024 || !validators.get(name)(args)
      || args.snapshot?.plans.some(plan => plan.source.trust !== 'declared')
      || args.snapshot?.routes.some(route => route.context.trust !== 'declared')) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid workbench arguments');
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
      const value = { schemaVersion: 'light-1.0', requestId: randomUUID(), status: 'rejected', supportedCapabilities,
        error: { code, message: code, currentRevision, retryable: false,
          recovery: code === 'INTERNAL_ERROR' || code === 'RECOVERY_REQUIRED' ? 'queryOriginalEventBeforeRetry' : 'readAndResolve' } };
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    }
  });
  return server;
}
