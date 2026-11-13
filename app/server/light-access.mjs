// 日期 2026-11-10。桌面私有入口管理授权，插件只使用独立的限范围令牌。
import { randomBytes, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { inspectWorkspace } from '../../plugins/task-workbench/skills/workbench-handoff/scripts/context-ledger.mjs';
import { digest } from './receipts.mjs';
import { lightError, requireLightShape } from './light-model.mjs';
import { agentApps, validAppId } from './light-apps.mjs';

const operations = new Set(['read', 'query', 'register', 'revise', 'confirmPublication', 'reserveExecution', 'update',
  'bind', 'proposeBinding', 'confirmBinding', 'revokeBinding', 'takeoverBinding', 'supplement', 'confirmSupplement',
  'approveSupplementCancellation', 'linkPlan', 'completePlan', 'coordinate']);
function requireBody(input, fields) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.acknowledged !== true
    || Object.keys(input).some(key => !fields.includes(key))) lightError('INVALID_INPUT', '需要明确确认及受支持字段');
}
function samePath(a, b) { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }
function contained(root, target) {
  const relative = path.relative(root, target);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}
function withoutConfirmation(input) { const { confirmationGrant, ...body } = input; return body; }

export function createLightAccess(persistence, { now = Date.now, presenceTtlMs = 35000 } = {}) {
  // Date: 2026-11-12. Presence is an expiring MCP-session lease, never a service health flag.
  const presence = new Map();
  const lastClientPresence = new Map();
  function grantFor(principal) {
    const grant = persistence.read('grants')[principal];
    return grant?.kind === 'lightAccess' && !grant.revokedAt ? grant : null;
  }
  function matches(grant, context) {
    if (grant.automatic === true) return context && typeof context.threadId === 'string' && !!context.threadId.trim()
      && context.hostId === 'local' && typeof context.worktreePath === 'string' && path.isAbsolute(context.worktreePath);
    return context && context.threadId === grant.threadId && context.hostId === grant.hostId
      && typeof context.worktreePath === 'string' && path.isAbsolute(context.worktreePath)
      && grant.worktreeRoots.some(root => contained(root, path.resolve(context.worktreePath)));
  }
  function authorize(principal, scope, operation, details = {}) {
    const grant = grantFor(principal);
    const projectKey = persistence.read('light')?.snapshot.projects.find(project => project.id === scope)?.key ?? scope;
    if (!grant || (!grant.automatic && !grant.projectKeys.includes(projectKey)) || !operations.has(operation)) return false;
    if (['confirmSupplement', 'approveSupplementCancellation'].includes(operation)) {
      const input = details.input, confirmation = persistence.read('grants')[input?.confirmationGrant];
      if (!confirmation || confirmation.kind !== 'lightSupplementConfirmation' || confirmation.principal !== principal
        || confirmation.operation !== operation || confirmation.expiresAt < Date.now()
        || confirmation.contentHash !== digest(withoutConfirmation(input))) return false;
    }
    const context = details.binding?.context ?? details.input?.context;
    const bindingOwner = details.binding && persistence.read('light')?.metadata.bindingOwners?.[details.binding.key];
    if (bindingOwner && bindingOwner !== principal) return false;
    const owner = details.binding?.confirmationRef;
    if (owner?.startsWith('automatic:') && owner !== `automatic:${principal}`) return false;
    return !context || matches(grant, context);
  }
  async function verifyWorktree(context, grant, checkHead = true) {
    if (!matches(grant, context)) lightError('FORBIDDEN', '会话及工作树超出授权', 403);
    try {
      const actual = await realpath(context.worktreePath);
      if (!grant.automatic && !grant.worktreeRoots.some(root => contained(root, actual))) lightError('FORBIDDEN', '实际路径超出授权', 403);
      const { branch, head, gitCommonDir } = await inspectWorkspace(actual);
      // 日期：2026-11-13。非 Git 无 HEAD；原生 detached 工作树仍需真实起始提交，不将两者混为一类。
      const detached = branch === null && gitCommonDir !== null;
      if (context.branch !== branch || branch === null && (!samePath(path.resolve(context.worktreePath), actual)
          || (detached ? !context.head : context.head !== null))
        || checkHead && context.head && context.head !== head) {
        lightError('STALE_BINDING', '实际目录、Git 分支或版本与提案不同', 409);
      }
      return { path: actual, branch, head };
    } catch (error) {
      if (error.code === 'FORBIDDEN' || error.code === 'STALE_BINDING') throw error;
      lightError('STALE_BINDING', '项目目录或 Git 工作树核验失败', 409);
    }
  }
  return {
    authorize,
    // 日期：2026-11-13。已开启自动连接的应用可从 MCP 首次登记，无需桌面私有确认票据。
    automaticPublication(principal, operation, input) {
      const grant = grantFor(principal);
      return grant?.automatic === true && input.confirmationGrant === null
        && authorize(principal, operation === 'register' ? input.snapshot?.projects[0]?.key : input.projectId,
          'confirmPublication', { input });
    },
    connect(input) {
      requireBody(input, ['acknowledged', 'appId']);
      if (input.appId !== undefined && !validAppId(input.appId)) lightError('INVALID_INPUT', '应用标识无效');
      return persistence.run(() => {
        const principal = randomUUID(), token = randomBytes(32).toString('hex');
        persistence.write('grants', { ...persistence.read('grants'), [principal]: { kind: 'lightAccess', tokenHash: digest(token),
          automatic: true, ...(input.appId ? { appId: input.appId } : {}), createdAt: new Date(now()).toISOString(), revokedAt: null } });
        return { principal, token, automatic: true };
      });
    },
    touch(principal, headers) {
      const grant = grantFor(principal);
      if (!grant || grant.appId && headers['x-workbench-app'] !== grant.appId) return;
      const client = headers['x-workbench-client'], session = headers['x-workbench-session'];
      if (typeof client !== 'string' || !/^[\x20-\x7e]{1,100}$/.test(client)
        || typeof session !== 'string' || !/^[a-f0-9-]{36}$/.test(session)) return;
      const sessions = presence.get(principal) ?? new Map();
      for (const [id, value] of sessions) if (now() - value.seenAt > presenceTtlMs) sessions.delete(id);
      if (headers['x-workbench-presence'] === 'offline') sessions.delete(session);
      else {
        if (sessions.size >= 100 && !sessions.has(session)) sessions.delete(sessions.keys().next().value);
        sessions.set(session, { client, seenAt: now() });
        if (grant.appId || /codex/i.test(client)) lastClientPresence.set(principal, now());
      }
      presence.set(principal, sessions);
    },
    connectionStatus(input) {
      requireBody(input, ['principal', 'acknowledged']);
      const grant = grantFor(input.principal);
      const allSessions = [...(presence.get(input.principal)?.values() ?? [])];
      const sessions = allSessions.filter(value => now() - value.seenAt <= presenceTtlMs);
      const online = sessions.filter(value => grant?.appId || /codex/i.test(value.client));
      const lastSeen = lastClientPresence.get(input.principal) ?? null;
      return { enabled: !!grant, automatic: grant?.automatic === true, connected: !!grant && online.length > 0,
        mcpConnected: !!grant && sessions.length > 0, lastSeenAt: lastSeen === null ? null : new Date(lastSeen).toISOString() };
    },
    panelConnections() {
      const grants = Object.entries(persistence.read('grants'));
      const apps = new Map();
      for (const [, grant] of grants) if (grant.kind === 'lightAccess') {
        const id = grant.appId ?? 'codex';
        apps.set(id, { id, name: grant.appName ?? agentApps.find(app => app.id === id)?.name ?? id });
      }
      return [...apps.values()].map(app => {
        const values = grants.filter(([, grant]) => grant.kind === 'lightAccess' && (grant.appId ?? 'codex') === app.id)
          .map(([principal]) => this.connectionStatus({ principal, acknowledged: true }));
        return { appId: app.id, name: app.name, enabled: values.some(v => v.enabled), connected: values.some(v => v.connected),
          lastSeenAt: values.map(v => v.lastSeenAt).filter(Boolean).sort().at(-1) ?? null };
      });
    },
    async automaticBinding(principal, binding, input) {
      const grant = grantFor(principal);
      if (grant?.automatic !== true) return false;
      if (!authorize(principal, input.projectId, 'confirmBinding', { input, binding })) lightError('FORBIDDEN', '自动绑定范围无效', 403);
      await verifyWorktree(binding.context, grant);
      return true;
    },
    authenticate(req) {
      if (req.headers.origin !== undefined || req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization').length !== 1) return null;
      const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '')?.[1];
      if (!token) return null;
      const tokenHash = digest(token);
      return Object.entries(persistence.read('grants')).find(([, grant]) => grant.kind === 'lightAccess'
        && !grant.revokedAt && grant.tokenHash === tokenHash)?.[0] ?? null;
    },
    issue(input) {
      requireBody(input, ['projectKeys', 'threadId', 'hostId', 'worktreeRoots', 'acknowledged']);
      return persistence.run(async () => {
        if (!Array.isArray(input.projectKeys) || !input.projectKeys.length || input.projectKeys.length > 20
          || input.projectKeys.some(key => typeof key !== 'string' || !key.trim() || key.length > 2000)
          || typeof input.threadId !== 'string' || !input.threadId.trim() || typeof input.hostId !== 'string' || !input.hostId.trim()
          || !Array.isArray(input.worktreeRoots) || !input.worktreeRoots.length || input.worktreeRoots.length > 20
          || input.worktreeRoots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) lightError('INVALID_INPUT', '授权范围或会话缺失');
        const worktreeRoots = await Promise.all(input.worktreeRoots.map(root => realpath(root)));
        const principal = randomUUID(), token = randomBytes(32).toString('hex');
        persistence.write('grants', { ...persistence.read('grants'), [principal]: { kind: 'lightAccess', tokenHash: digest(token),
          projectKeys: [...new Set(input.projectKeys)], threadId: input.threadId, hostId: input.hostId,
          worktreeRoots, createdAt: new Date().toISOString(), revokedAt: null } });
        return { principal, token, projectKeys: input.projectKeys, threadId: input.threadId, hostId: input.hostId };
      });
    },
    revoke(input) {
      requireBody(input, ['principal', 'acknowledged']);
      return persistence.run(() => {
        const grants = persistence.read('grants'), grant = grantFor(input.principal);
        if (!grant) lightError('NOT_FOUND', '授权不存在', 404);
        grants[input.principal] = { ...grant, revokedAt: new Date().toISOString() };
        for (const [key, pending] of Object.entries(grants)) if (pending.kind === 'lightOnboarding'
          && (pending.appId === null || pending.appId === (grant.appId ?? 'codex'))) grants[key] = { ...pending, revokedAt: new Date().toISOString() };
        persistence.write('grants', grants);
        return { principal: input.principal, revoked: true };
      });
    },
    async confirmPublication(publisher, body) {
      requireBody(body, ['principal', 'operation', 'input', 'acknowledged']);
      return publisher.confirm(body.principal, body.operation, body.input);
    },
    confirmSupplement(body) {
      requireBody(body, ['principal', 'input', 'acknowledged']);
      return persistence.run(() => {
        const input = requireLightShape('supplementWrite', body.input);
        if (!authorize(body.principal, input.projectId, 'supplement', { input })) lightError('FORBIDDEN', '补充事项超出授权', 403);
        const snapshot = persistence.read('light')?.snapshot;
        const project = snapshot?.projects.find(item => item.id === input.projectId);
        const plan = snapshot?.plans.find(item => item.id === input.planId && item.projectKey === project?.key);
        const step = snapshot?.steps.find(item => item.id === input.sourceStepId && item.planKey === plan?.key);
        const item = snapshot?.supplements.find(item => item.id === input.supplementId && item.sourceStepKey === step?.key);
        if (!item || project.revision !== input.expectedRevision || input.blocksSource !== item.blocksSource || input.repairId !== item.repairId
          || ['path', 'version', 'sha256'].some(key => input.source[key] !== plan.source[key])) lightError('STALE_PLAN', '补充事项来源或版本已变化', 409);
        let operation;
        if (input.action === 'update' && input.status === 'unplanned' && item.status === 'unconfirmed'
          && input.repairId === item.repairId && input.blocksSource === item.blocksSource) operation = 'confirmSupplement';
        else if (input.action === 'cancel' && item.blocksSource && !['completed', 'cancelled'].includes(item.status)) {
          if (!input.cancellationHandoff?.trim()) lightError('CONFIRMATION_REQUIRED', '取消必要事项须明确替代或承接');
          operation = 'approveSupplementCancellation';
        } else lightError('INVALID_TRANSITION', '仅确认规划或必要事项取消承接');
        const confirmationGrant = randomUUID();
        persistence.write('grants', { ...persistence.read('grants'), [confirmationGrant]: { kind: 'lightSupplementConfirmation',
          principal: body.principal, operation, contentHash: digest(withoutConfirmation(input)), expiresAt: Date.now() + 15 * 60 * 1000 } });
        return { confirmationGrant, operation };
      });
    },
    confirmBinding(body) {
      requireBody(body, ['principal', 'input', 'acknowledged']);
      return persistence.run(async () => {
        const input = body.input;
        requireLightShape('bind', { ...input, confirmationGrant: 'pending-confirmation' });
        if (input.action !== 'confirm' || !authorize(body.principal, input.projectId, 'confirmBinding', { input })) lightError('FORBIDDEN', '绑定确认超出授权', 403);
        const snapshot = persistence.read('light')?.snapshot;
        const project = snapshot?.projects.find(project => project.id === input.projectId);
        const binding = snapshot?.bindings.find(binding => binding.id === input.bindingId);
        if (!binding || binding.state !== 'proposed' || binding.bindingRevision !== input.expectedBindingRevision
          || binding.projectKey !== project?.key || snapshot.plans.find(plan => plan.id === input.planId)?.key !== binding.planKey
          || project.revision !== input.expectedRevision || digest(binding.context) !== digest(input.context)
          || digest(binding.stepKeys) !== digest(input.stepIds.map(id => snapshot.steps.find(step => step.id === id)?.key))) lightError('STALE_BINDING', '提案与确认内容不一致', 409);
        if (digest(persistence.read('light').metadata.bindingIntents?.[binding.key]?.takeover ?? null) !== digest(input.takeover ?? null)) lightError('STALE_BINDING', '接手意图与提案不一致', 409);
        const observed = await verifyWorktree(input.context, grantFor(body.principal));
        const confirmationGrant = randomUUID();
        persistence.write('grants', { ...persistence.read('grants'), [confirmationGrant]: { kind: 'lightBindingConfirmation',
          principal: body.principal, contentHash: digest(withoutConfirmation(input)), observed, expiresAt: Date.now() + 15 * 60 * 1000 } });
        return { confirmationGrant, observed };
      });
    },
    async verifyBinding(principal, binding, input) {
      const grant = grantFor(principal), confirmation = persistence.read('grants')[input.confirmationGrant];
      if (grant?.automatic === true && input.confirmationGrant === null) {
        await verifyWorktree(binding.context, grant);
        return true;
      }
      if (!grant || !confirmation || confirmation.kind !== 'lightBindingConfirmation' || confirmation.principal !== principal
        || confirmation.expiresAt < Date.now() || confirmation.contentHash !== digest(withoutConfirmation(input))) return false;
      await verifyWorktree(binding.context, grant);
      return true;
    },
    async verifyExecutionContext(principal, binding) {
      const grant = grantFor(principal);
      if (!grant) return false;
      // 确认时记录起始 HEAD，执行期允许同一分支正常提交。
      await verifyWorktree(binding.context, grant, false);
      return true;
    },
  };
}
