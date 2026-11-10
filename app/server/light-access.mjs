// 日期 2026-11-10。桌面私有入口管理授权，插件只使用独立的限范围令牌。
import { randomBytes, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { digest } from './receipts.mjs';
import { lightError, requireLightShape } from './light-model.mjs';

const git = promisify(execFile);
const operations = new Set(['read', 'query', 'register', 'revise', 'confirmPublication', 'reserveExecution', 'update',
  'bind', 'proposeBinding', 'confirmBinding', 'revokeBinding', 'supplement', 'linkPlan', 'completePlan']);
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

export function createLightAccess(persistence) {
  function grantFor(principal) {
    const grant = persistence.read('grants')[principal];
    return grant?.kind === 'lightAccess' && !grant.revokedAt ? grant : null;
  }
  function matches(grant, context) {
    return context && context.threadId === grant.threadId && context.hostId === grant.hostId
      && typeof context.worktreePath === 'string' && path.isAbsolute(context.worktreePath)
      && grant.worktreeRoots.some(root => contained(root, path.resolve(context.worktreePath)));
  }
  function authorize(principal, scope, operation, details = {}) {
    const grant = grantFor(principal);
    const projectKey = persistence.read('light')?.snapshot.projects.find(project => project.id === scope)?.key ?? scope;
    if (!grant || !grant.projectKeys.includes(projectKey) || !operations.has(operation)) return false;
    const context = details.binding?.context ?? details.input?.context;
    return !context || matches(grant, context);
  }
  async function verifyWorktree(context, grant, checkHead = true) {
    if (!matches(grant, context)) lightError('FORBIDDEN', '会话及工作树超出授权', 403);
    try {
      const actual = await realpath(context.worktreePath);
      if (!grant.worktreeRoots.some(root => contained(root, actual))) lightError('FORBIDDEN', '实际路径超出授权', 403);
      const options = { cwd: actual, timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 };
      const top = (await git('git', ['rev-parse', '--show-toplevel'], options)).stdout.trim();
      const branch = (await git('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], options)).stdout.trim();
      const head = (await git('git', ['rev-parse', 'HEAD'], options)).stdout.trim();
      if (!samePath(await realpath(top), actual) || context.branch !== branch || checkHead && context.head && context.head !== head) {
        lightError('STALE_BINDING', '实际 Git 工作树或版本与提案不同', 409);
      }
      return { path: actual, branch, head };
    } catch (error) {
      if (error.code === 'FORBIDDEN' || error.code === 'STALE_BINDING') throw error;
      lightError('STALE_BINDING', 'Git 工作树核验失败', 409);
    }
  }
  return {
    authorize,
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
        persistence.write('grants', grants);
        return { principal: input.principal, revoked: true };
      });
    },
    async confirmPublication(publisher, body) {
      requireBody(body, ['principal', 'operation', 'input', 'acknowledged']);
      return publisher.confirm(body.principal, body.operation, body.input);
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
        const observed = await verifyWorktree(input.context, grantFor(body.principal));
        const confirmationGrant = randomUUID();
        persistence.write('grants', { ...persistence.read('grants'), [confirmationGrant]: { kind: 'lightBindingConfirmation',
          principal: body.principal, contentHash: digest(withoutConfirmation(input)), observed, expiresAt: Date.now() + 15 * 60 * 1000 } });
        return { confirmationGrant, observed };
      });
    },
    async verifyBinding(principal, binding, input) {
      const grant = grantFor(principal), confirmation = persistence.read('grants')[input.confirmationGrant];
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
