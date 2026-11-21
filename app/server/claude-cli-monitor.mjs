import http from 'node:http';
import { HttpError } from './validation.mjs';

const HOST = '127.0.0.1';
const PORT = 47823;
const HOOK_PATH = '/claude/hook';
export const CLAUDE_CODE_HOOK_URL = `http://${HOST}:${PORT}${HOOK_PATH}`;
const MAX_SESSIONS = 100;

const states = new Map([
  ['SessionStart', 'waitingInput'],
  ['UserPromptSubmit', 'running'],
  ['PreToolUse', 'running'],
  ['PostToolUse', 'running'],
  ['PostToolUseFailure', 'running'],
  ['Stop', 'turnEnded'],
  ['StopFailure', 'turnEnded'],
  ['SessionEnd', 'ended'],
]);
const notifications = new Map([
  ['permission_prompt', 'waitingApproval'],
  ['idle_prompt', 'waitingInput'],
]);

const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const readablePath = value => typeof value === 'string' && value.length <= 4096 && value.trim() && !/[\x00-\x1f\x7f]/.test(value);

export function createClaudeCliMonitor({ checkLocalRequest, jsonBody, port = PORT }) {
  const sessions = new Map();
  let lastEventAt = null;
  let error = null;

  function observe(input) {
    const { session_id: sessionId, hook_event_name: event, prompt_id: promptId, notification_type: notificationType, cwd } = input ?? {};
    if (!identifier(sessionId) || !identifier(event)) throw new HttpError(400, 'INVALID_CLAUDE_HOOK');
    lastEventAt = new Date().toISOString();
    const status = event === 'Notification' ? notifications.get(notificationType) : states.get(event);
    // PermissionRequest can be resolved by another hook before a prompt is shown.
    if (!status || input.agent_id) return;
    const previous = sessions.get(sessionId);
    const startsTurn = event === 'UserPromptSubmit';
    const startsSession = event === 'SessionStart';
    const endsSession = event === 'SessionEnd';
    const reportedPromptId = identifier(promptId) ? promptId : null;
    // Start hooks may run in the background, including during transcript compaction.
    if (startsSession && (input.source === 'compact' || previous && previous.view.status !== 'ended')) return;
    if (previous?.view.status === 'ended' && !startsTurn && !startsSession && !endsSession) return;
    // Recent CLI versions identify the prompt, so a late event cannot overwrite a newer turn.
    if (!startsTurn && !startsSession && !endsSession && previous?.promptId && reportedPromptId && reportedPromptId !== previous.promptId) return;
    // A late result from the same turn does not undo its completion. A new tool
    // request may follow Stop when another hook asks Claude to keep working.
    const toolResult = event === 'PostToolUse' || event === 'PostToolUseFailure';
    if (toolResult && previous?.view.status === 'turnEnded' && previous.promptId && reportedPromptId === previous.promptId) return;

    const view = { sessionId, cwd: readablePath(cwd) ? cwd : previous?.view.cwd ?? null, status, event, updatedAt: lastEventAt,
      ...(event === 'Notification' ? { notificationType } : {}) };
    sessions.delete(sessionId);
    const previousPromptId = startsTurn || startsSession ? null : previous?.promptId;
    sessions.set(sessionId, { view, promptId: reportedPromptId ?? previousPromptId });
    if (sessions.size > MAX_SESSIONS) {
      const ended = [...sessions].find(([, entry]) => entry.view.status === 'ended');
      sessions.delete(ended?.[0] ?? sessions.keys().next().value);
    }
  }

  // Keep the legacy no-credential callback off the private management listener.
  const receiver = http.createServer({ requestTimeout: 5000, headersTimeout: 3000, connectionsCheckingInterval: 3000 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      checkLocalRequest(req);
      if (req.headers.origin !== undefined) throw new HttpError(403, 'FORBIDDEN');
      if (req.url !== HOOK_PATH) throw new HttpError(404, 'NOT_FOUND');
      if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
      observe(await jsonBody(req));
      res.writeHead(204).end();
    } catch (failure) {
      if (!res.destroyed) res.writeHead(failure instanceof HttpError ? failure.status : 500, { Connection: 'close' }).end();
    }
  });
  receiver.on('error', failure => { error = failure.code ?? 'CLAUDE_HOOK_LISTENER_ERROR'; });
  return {
    start() {
      return new Promise(resolve => {
        const ready = () => { receiver.off('error', failed); resolve(); };
        const failed = () => { receiver.off('listening', ready); resolve(); };
        receiver.once('listening', ready).once('error', failed).listen(port, HOST);
      });
    },
    close() {
      return new Promise(resolve => {
        receiver.close(resolve);
        receiver.closeIdleConnections();
      });
    },
    status: () => ({ listening: receiver.listening, lastEventAt, error }),
    address: () => receiver.address(),
    read: () => [...sessions.values()].reverse().map(({ view }) => view),
  };
}
