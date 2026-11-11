// 日期 2026-11-11。服务与模拟共享面板类型；真实读取不降级到模拟数据。
import fixture from './light-simulation.json';
import { api } from './domain';

export type Preferences = { collapsed: string[]; selected: string; focus: string[]; scroll: Record<string, number>; y: Record<string, number> };
export type Binding = { key: string; id: string | null; state: string; context: { threadId: string | null; hostId: string | null; branch: string | null; worktreePath: string | null } };
type Step = Omit<typeof fixture.steps[number], 'blockers'> & { blockers: { blockerId: string; reason: string; waitingFor: string[]; releaseConditions: string[]; resolved: boolean }[] };
export type Snapshot = Omit<typeof fixture, 'steps' | 'bindings' | 'executions' | 'events'> & {
  steps: Step[]; bindings: Binding[]; executions: { key: string; id: string; stepKey: string }[];
  events: { eventId: string; stepKey: string | null; reason: string; occurredAt: string; receivedAt: string; toStatus: string | null }[];
};
export type PanelRead = { snapshot: Snapshot; sources: Record<string, string | null>; preferences: Preferences | null; capabilities: { threadJump: boolean; reason: string } };
export const blankSnapshot: Snapshot = { ...fixture, mode: 'service', revision: null, projects: [], plans: [], steps: [], routes: [], bindings: [], executions: [], supplements: [], events: [] };
export const readPanel = () => api<PanelRead>('/light-panel');
export const savePanelPreferences = (preferences: Preferences) => api('/light-panel/preferences', 'PUT', preferences);
