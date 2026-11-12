// Date: 2026-11-12. Desktop-created, expiring application tickets delegate only connection enablement.
import { randomBytes, randomUUID } from 'node:crypto';
import { digest } from './receipts.mjs';
import { lightError } from './light-model.mjs';
import { validAppId } from './light-apps.mjs';

export function createLightOnboarding(persistence, { now = Date.now } = {}) {
  return {
    prepare(input) {
      if (!input || !validAppId(input.appId) || input.acknowledged !== true
        || Object.keys(input).some(key => !['appId','acknowledged'].includes(key))) lightError('INVALID_INPUT', '接入应用无效');
      return persistence.run(() => {
        const ticket = randomBytes(32).toString('hex'), requestId = randomUUID(), expiresAt = now() + 30 * 60 * 1000;
        const grants = persistence.read('grants');
        for (const [key, value] of Object.entries(grants)) if (value.kind === 'lightOnboarding' && value.expiresAt < now()) delete grants[key];
        grants[`onboarding:${digest(ticket)}`] = { kind: 'lightOnboarding', requestId, appId: input.appId, expiresAt, principal: null };
        persistence.write('grants', grants);
        return { ticket, requestId, appId: input.appId, expiresAt: new Date(expiresAt).toISOString() };
      });
    },
    redeem(input) {
      if (!input || !validAppId(input.appId) || typeof input.ticket !== 'string' || !/^[a-f0-9]{64}$/.test(input.ticket)
        || Object.keys(input).some(key => !['appId','ticket','currentToken'].includes(key))
        || input.currentToken !== undefined && (typeof input.currentToken !== 'string' || !/^[a-f0-9]{64}$/.test(input.currentToken))) {
        lightError('FORBIDDEN', '接入请求无效', 403);
      }
      return persistence.run(() => {
        const grants = persistence.read('grants'), key = `onboarding:${digest(input.ticket)}`, request = grants[key];
        if (!request || request.kind !== 'lightOnboarding' || request.revokedAt || request.appId !== input.appId || request.expiresAt <= now()) {
          lightError('FORBIDDEN', '接入请求已失效，请重新复制指令', 403);
        }
        const derived = digest(['task-island-onboarding', input.ticket]);
        if (request.principal) {
          const token = request.reused ? input.currentToken : derived, grant = grants[request.principal];
          if (!token || !grant || grant.revokedAt || grant.tokenHash !== digest(token)) lightError('FORBIDDEN', '连接已撤销或需核对本机配置', 403);
          return { principal: request.principal, token, appId: request.appId, automatic: true };
        }
        const existing = input.currentToken && Object.entries(grants).find(([, grant]) => grant.kind === 'lightAccess'
          && grant.automatic === true && !grant.revokedAt && (grant.appId ?? 'codex') === input.appId && grant.tokenHash === digest(input.currentToken));
        const principal = existing?.[0] ?? randomUUID(), token = existing ? input.currentToken : derived;
        if (!existing) grants[principal] = { kind: 'lightAccess', tokenHash: digest(token), appId: request.appId,
          automatic: true, createdAt: new Date(now()).toISOString(), revokedAt: null };
        grants[key] = { ...request, principal, reused: !!existing };
        persistence.write('grants', grants);
        return { principal, token, appId: request.appId, automatic: true };
      });
    },
  };
}
