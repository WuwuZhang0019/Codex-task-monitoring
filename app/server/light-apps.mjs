// Date: 2026-11-12. Stable application identities shared by access and presentation adapters.
export const agentApps = [
  { id: 'codex', name: 'Codex' }, { id: 'claude-code', name: 'Claude Code' },
  { id: 'dsh', name: 'dsh' }, { id: 'workbuddy', name: 'WorkBuddy' },
];
export const validAppId = id => typeof id === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(id) && !['all','unassigned'].includes(id);
export const validAppName = name => typeof name === 'string' && !!name.trim() && name.length <= 80 && !/[\x00-\x1f\x7f]/.test(name);
