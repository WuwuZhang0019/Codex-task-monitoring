// 日期 2026-11-10。发送前持久保存精确请求，重开时查询或重放同一请求。
import { digest } from './receipts.mjs';
import { lightError, requireLightShape } from './light-model.mjs';

export function validateLightOutbox(entries) {
  if (entries === undefined) return;
  for (const entry of Object.values(entries)) {
    if (entry.version !== 1 || digest(entry.request) !== entry.semanticHash || !['pendingSync', 'unknown', 'synced', 'rejected'].includes(entry.sync)) {
      lightError('INVALID_OUTBOX', '发送队列损坏');
    }
  }
}

export function createLightOutbox(persistence) {
  function indexOf(owner, operation, eventId) { return digest([owner, operation, eventId]); }
  async function modify(index, transform) {
    return persistence.run(() => {
      const entries = persistence.read('lightOutbox') ?? {};
      const result = transform(entries);
      validateLightOutbox(entries);
      persistence.write('lightOutbox', entries);
      return structuredClone(result ?? entries[index]);
    });
  }
  return {
    list(owner) { return Object.values(persistence.read('lightOutbox') ?? {}).filter(item => item.owner === owner); },
    enqueue(owner, operation, request, localContext = {}) {
      if (!owner || !operation || !request.eventId) lightError('INVALID_INPUT', '发送侧作用域缺失');
      const index = indexOf(owner, operation, request.eventId), semanticHash = digest(request);
      return modify(index, entries => {
        const old = entries[index];
        if (old) {
          if (old.semanticHash !== semanticHash) lightError('IDEMPOTENCY_CONFLICT', '原发送事件不能改写', 409);
          return old;
        }
        entries[index] = { version: 1, owner, operation, eventId: request.eventId, semanticHash, request: structuredClone(request),
          localContext: structuredClone(localContext), sync: 'pendingSync', attempted: false, receipt: null,
          serviceProjectId: request.projectId ?? null, committedRevision: null, receivedAt: null, lastError: null };
      });
    },
    prepare(owner, operation, eventId, request) {
      const index = indexOf(owner, operation, eventId);
      return modify(index, entries => {
        const entry = entries[index];
        if (!entry || request.eventId !== eventId) lightError('NOT_FOUND', '发送候选不存在或事件不匹配');
        if (entry.attempted || entry.sync !== 'pendingSync') lightError('RESULT_UNKNOWN', '已发送请求必须保留精确原文');
        entry.request = structuredClone(request); entry.semanticHash = digest(request); entry.serviceProjectId = request.projectId ?? null;
      });
    },
    async synchronize(owner, operation, eventId, transport) {
      const index = indexOf(owner, operation, eventId);
      const entry = await modify(index, entries => {
        const current = entries[index];
        if (!current) lightError('NOT_FOUND', '待同步事件不存在');
        const original = structuredClone(current);
        if (!['synced', 'rejected'].includes(current.sync)) { current.attempted = true; current.sync = 'unknown'; }
        return original;
      });
      if (['synced', 'rejected'].includes(entry.sync)) return entry;
      let result;
      try {
        if (entry.attempted && transport.query) result = await transport.query(structuredClone(entry));
        if (result?.state === 'committed') result = result.result?.receipt ?? result.result;
        else result = await transport.send(structuredClone(entry.request));
        result = result?.receipt ?? result;
        requireLightShape('receipt', result);
        if (result.eventId !== entry.eventId) lightError('RESULT_UNKNOWN', '回执事件不匹配');
      } catch (error) {
        return modify(index, entries => {
          if (!['synced', 'rejected'].includes(entries[index].sync)) {
            entries[index].sync = 'unknown'; entries[index].lastError = { code: error.code ?? 'RESULT_UNKNOWN', message: error.message };
          }
        });
      }
      return modify(index, entries => {
        const current = entries[index];
        if (['synced', 'rejected'].includes(current.sync)) return current;
        current.receipt = result;
        current.sync = ({ committed: 'synced', rejected: 'rejected', pending: 'unknown', unknown: 'unknown' })[result.status];
        current.committedRevision = result.committedRevision; current.receivedAt = result.receivedAt; current.lastError = null;
      });
    },
  };
}
