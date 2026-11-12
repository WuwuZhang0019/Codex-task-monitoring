// 日期 2026-11-10。仅已认证所有者调用 confirm，MCP 仅持有 publish 能力。
import { randomUUID } from 'node:crypto';
import { digest } from './receipts.mjs';
import { lightError, validateLightSnapshot } from './light-model.mjs';

export function createLightPublication(persistence, requests, service, { authorize = () => false, automaticPublication = () => false } = {}) {
  function permitted(principal, scope, operation, details = {}) {
    if (!principal || authorize(principal, scope, operation, details) !== true) lightError('FORBIDDEN', '发布授权不足', 403);
  }
  function scopeOf(operation, input) {
    if (!['register', 'revise'].includes(operation)) lightError('INVALID_INPUT', '发布操作无效');
    return operation === 'register' ? input.snapshot?.projects[0]?.key : input.projectId;
  }
  function content(input) {
    const { confirmationGrant, ...body } = input;
    return body;
  }
  function validatePublication(principal, operation, input) {
    const snapshot = validateLightSnapshot(structuredClone(input.snapshot));
    if (snapshot.plans.length !== 1 || ['path', 'version', 'sha256'].some(key => input.source?.[key] !== snapshot.plans[0].source[key])) lightError('STALE_PLAN', '确认来源与快照不一致');
    if (operation === 'revise') {
      const current = service.read(principal, input.projectId);
      if (current.projects.find(project => project.id === input.projectId)?.revision !== input.expectedRevision) lightError('REVISION_CONFLICT', '确认版本已变化', 409);
    }
  }
  return {
    confirm(principal, operation, input) {
      return persistence.run(() => {
        const scope = scopeOf(operation, input);
        permitted(principal, scope, 'confirmPublication', { input, operation });
        validatePublication(principal, operation, input);
        const confirmationGrant = randomUUID();
        persistence.write('grants', { ...persistence.read('grants'), [confirmationGrant]: {
          kind: 'lightPublication', principal, operation, scope, contentHash: digest(content(input)), expiresAt: Date.now() + 15 * 60 * 1000,
        } });
        return { confirmationGrant, contentHash: digest(content(input)) };
      });
    },
    publish(principal, operation, input) {
      const scope = scopeOf(operation, input);
      permitted(principal, scope, operation, { input });
      return requests.execute(principal, scope, `light.publish.${operation}`, { ...input, idempotencyKey: input.eventId }, async () => {
        const grant = persistence.read('grants')[input.confirmationGrant];
        const automatic = automaticPublication(principal, operation, input) === true;
        if (automatic) validatePublication(principal, operation, input);
        else if (!grant || grant.kind !== 'lightPublication' || grant.principal !== principal || grant.operation !== operation
          || grant.scope !== scope || grant.expiresAt < Date.now() || grant.contentHash !== digest(content(input))) lightError('CONFIRMATION_REQUIRED', '确认过期或内容发生变化', 409);
        const result = await service[operation](principal, content(input));
        return result;
      }, () => permitted(principal, scope, operation, { input }));
    },
  };
}
