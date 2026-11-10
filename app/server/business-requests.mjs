import { randomUUID } from 'node:crypto';
import { digest } from './receipts.mjs';
import { HttpError } from './validation.mjs';

// Principal is supplied by the trusted UI/MCP adapter, never taken from the body.
export function createRequests(persistence) {
  return {
    query(principal, projectId, operation, key) {
      return persistence.read('requests')[digest([principal, projectId, operation, key])] ?? { state: 'unknown' };
    },
    execute(principal, projectId, operation, input, change) {
      if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) throw new HttpError(400, 'idempotencyKey 必须填写');
      const index = digest([principal, projectId, operation, input.idempotencyKey]);
      const semanticHash = digest(input);
      return persistence.run(async () => {
        const requests = persistence.read('requests');
        const previous = requests[index];
        if (previous) {
          if (previous.semanticHash !== semanticHash) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT');
          return previous.result;
        }
        const requestId = randomUUID();
        const result = { ...await change(), requestId };
        requests[index] = { state: 'committed', requestId, semanticHash, result };
        persistence.write('requests', requests);
        persistence.write('audit', [...persistence.read('audit'), { requestId, principal, projectId, operation, semanticHash, time: new Date().toISOString() }]);
        persistence.write('events', [...persistence.read('events'), { id: requestId, projectId, operation, revision: result.revision ?? null }]);
        return result;
      });
    },
  };
}
