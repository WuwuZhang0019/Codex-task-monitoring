// Date: 2026-11-12. Stable application identities shared by access and presentation adapters.
export const agentApps = [
  { id: 'codex', name: 'Codex' }, { id: 'claude-code', name: 'Claude Code' },
  { id: 'dsh', name: 'dsh' }, { id: 'workbuddy', name: 'WorkBuddy' },
];
export const validAppId = id => agentApps.some(app => app.id === id);
