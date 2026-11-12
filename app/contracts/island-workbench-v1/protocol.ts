// Contract owner: Codex-task-monitoring. Date: 2026-11-12.
// Date: 2026-11-12. Optional application presentation metadata; light-1.0 business identity remains unchanged.
export type AppId = string;
export type AgentConnection = {
	appId: AppId;
	name: string;
	enabled: boolean;
	connected: boolean;
	lastSeenAt: string | null;
};
export const PROTOCOL_VERSION = "island-workbench/1" as const;
export const SNAPSHOT_VERSION = "light-1.0" as const;
export type StepStatus = "pending" | "running" | "blocked" | "completed" | "cancelled";
export type ConnectionState = "ready" | "offline" | "unauthorized" | "stale" | "incompatible" | "unknown";
export interface Entity {
	key: string;
	id: string | null;
}
export interface Project extends Entity {
	name: string;
	planKeys: string[];
	revision: number | null;
}
export interface Plan extends Entity {
	projectKey: string;
	name: string;
	stageCount: number;
	stageKeys: string[];
	source: { path: string; version: string; sha256: string; locator: string; trust: string };
	endConditions: unknown[];
}
export interface Blocker {
	blockerId: string;
	reason: string;
	waitingFor: string[];
	releaseConditions: string[];
	resolved: boolean;
}
export interface Step extends Entity {
	projectKey: string;
	planKey: string;
	parentKey: string | null;
	code: string;
	originalCode: string | null;
	title: string;
	order: number;
	required: boolean;
	dependsOn: string[];
	status: StepStatus;
	acceptance: string;
	sync: string;
	conditions: unknown[];
	evidence: unknown[];
	blockers: Blocker[];
	bindingKey: string | null;
	executionKey: string | null;
	updatedAt: string;
}
export interface Context {
	threadId: string | null;
	hostId: string | null;
	branch: string | null;
	worktreePath: string | null;
}
export interface Route extends Entity {
	projectKey: string;
	planKey: string;
	label: string;
	stepKeys: string[];
	order: number;
	context: Context;
	sourceStepKey: string | null;
	returnStepKey: string | null;
}
export interface Binding extends Entity {
	projectKey: string;
	planKey: string;
	stepKeys: string[];
	state: string;
	bindingRevision: number | null;
	context: Context;
}
export interface Execution extends Entity {
	projectKey: string;
	planKey: string;
	stepKeys: string[];
	bindingKey: string | null;
	outcome: string | null;
}
export interface Supplement extends Entity {
	sourceStepKey: string;
	title: string;
	goal: string;
	blocksSource: boolean;
	status: string;
	linkedPlanKey: string | null;
	repairId: string | null;
}
export interface StatusEvent {
	eventId: string;
	stepKey: string | null;
	executionKey: string | null;
	reason: string;
	occurredAt: string;
	receivedAt: string;
	toStatus: StepStatus | null;
}
export interface WorkbenchSnapshot {
	schemaVersion: typeof SNAPSHOT_VERSION;
	date: string;
	mode: "simulation" | "service";
	revision: number | null;
	generatedAt: string;
	projects: Project[];
	plans: Plan[];
	steps: Step[];
	routes: Route[];
	bindings: Binding[];
	executions: Execution[];
	supplements: Supplement[];
	events: StatusEvent[];
}
export interface Preferences {
	collapsed: string[];
	selected: string;
	focus: string[];
	scroll: Record<string, number>;
	y: Record<string, number>;
}
export interface Connection {
	state: ConnectionState;
	healthy: boolean;
	lastSuccessAt: string | null;
	message: string;
}
export interface UnknownOperation {
	eventId: string;
	state: "unknown";
	reason: string;
}
export interface WorkbenchEnvelope {
	agentApps?: AgentConnection[];
	bindingApps?: Record<string, AppId>;
	protocolVersion: typeof PROTOCOL_VERSION;
	mode: "simulation" | "service";
	snapshot: WorkbenchSnapshot | null;
	capabilities: { threadJump: boolean; worktreeOpen: boolean; businessWrite: boolean; reason: string };
	connection: Connection;
	pendingOperation: UnknownOperation | null;
}
export interface EventResult {
	eventId: string;
	state: "unknown" | "committed" | "notFound";
	committedRevision: number | null;
}
export interface WorkbenchClient {
	readonly mode: "simulation" | "service";
	read(): Promise<WorkbenchEnvelope>;
	queryEvent(eventId: string): Promise<EventResult>;
}

const validAppIdentity = (value: unknown) =>
	typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value) && !["all", "unassigned"].includes(value);
const object = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const fail = (message: string): never => {
	throw new Error(`INVALID_WORKBENCH_CONTRACT: ${message}`);
};
const text = (x: unknown) => typeof x === "string" && x.length <= 100000;
const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every(text);
const nullableText = (x: unknown) => x === null || text(x);
const revision = (x: unknown) => x === null || (Number.isSafeInteger(x) && Number(x) >= 0);
const validContext = (x: unknown) =>
	object(x) && ["threadId", "hostId", "branch", "worktreePath"].every((k) => nullableText(x[k]));
const statuses: string[] = ["pending", "running", "blocked", "completed", "cancelled"];
const states: string[] = ["ready", "offline", "unauthorized", "stale", "incompatible", "unknown"];

// Presentation validation only. Completion, dependencies and authorization stay service-owned.
export function validateEnvelope(value: unknown): WorkbenchEnvelope {
	if (!object(value) || value.protocolVersion !== PROTOCOL_VERSION) fail("unsupported protocol version");
	const e = value as unknown as WorkbenchEnvelope;
	if (
		!["simulation", "service"].includes(e.mode) ||
		!object(e.connection) ||
		!states.includes(e.connection.state) ||
		typeof e.connection.healthy !== "boolean" ||
		!nullableText(e.connection.lastSuccessAt) ||
		!text(e.connection.message) ||
		!object(e.capabilities) ||
		["threadJump", "worktreeOpen", "businessWrite"].some(
			(k) => typeof e.capabilities[k as keyof typeof e.capabilities] !== "boolean",
		) ||
		!text(e.capabilities.reason)
	)
		fail("connection or capabilities");
	if (e.mode === "simulation" && e.capabilities.businessWrite) fail("simulation cannot write business state");
	if (
		e.pendingOperation !== null &&
		(!object(e.pendingOperation) ||
			!text(e.pendingOperation.eventId) ||
			!e.pendingOperation.eventId ||
			e.pendingOperation.state !== "unknown" ||
			!text(e.pendingOperation.reason))
	)
		fail("pending operation");
	if (
		e.agentApps !== undefined &&
		(!Array.isArray(e.agentApps) ||
			e.agentApps.some(
				(app) =>
					!object(app) ||
					!validAppIdentity(app.appId) ||
					typeof app.name !== "string" ||
					typeof app.enabled !== "boolean" ||
					typeof app.connected !== "boolean" ||
					!nullableText(app.lastSeenAt),
			))
	)
		fail("agent connections");
	if (
		e.bindingApps !== undefined &&
		(!object(e.bindingApps) || Object.values(e.bindingApps).some((app) => !validAppIdentity(app)))
	)
		fail("binding applications");
	const s = e.snapshot;
	if (s === null) {
		if (e.connection.state === "ready") fail("ready requires a snapshot");
		return structuredClone(e);
	}
	if (
		!object(s) ||
		s.schemaVersion !== SNAPSHOT_VERSION ||
		s.mode !== e.mode ||
		!revision(s.revision) ||
		!text(s.date) ||
		!text(s.generatedAt)
	)
		fail("snapshot header");
	if (e.mode === "service" && (s.revision === null || !Number.isSafeInteger(s.revision)))
		fail("service revision required");
	const groups = ["projects", "plans", "steps", "routes", "bindings", "executions", "supplements"] as const;
	const all: Entity[] = [];
	for (const k of groups) {
		if (!Array.isArray(s[k])) fail(`missing ${k}`);
		for (const item of s[k]) {
			if (!object(item) || !text(item.key) || !item.key || !nullableText(item.id)) fail(`invalid ${k} identity`);
			if (e.mode === "service" && !item.id) fail("service entity requires fixed id");
			all.push(item);
		}
	}
	if (
		new Set(all.map((x) => x.key)).size !== all.length ||
		new Set(all.filter((x) => x.id).map((x) => x.id)).size !== all.filter((x) => x.id).length
	)
		fail("duplicate identity");
	const projects = new Map(s.projects.map((x) => [x.key, x]));
	const plans = new Map(s.plans.map((x) => [x.key, x]));
	const steps = new Map(s.steps.map((x) => [x.key, x]));
	for (const p of s.projects)
		if (
			!text(p.name) ||
			!strings(p.planKeys) ||
			!revision(p.revision) ||
			p.planKeys.some((k) => plans.get(k)?.projectKey !== p.key)
		)
			fail("project");
	for (const p of s.plans)
		if (
			!text(p.name) ||
			!projects.get(p.projectKey)?.planKeys.includes(p.key) ||
			!strings(p.stageKeys) ||
			p.stageKeys.some((k) => steps.get(k)?.planKey !== p.key) ||
			!Number.isSafeInteger(p.stageCount) ||
			!object(p.source) ||
			["path", "version", "sha256", "locator", "trust"].some((k) => !text(p.source[k as keyof typeof p.source])) ||
			!Array.isArray(p.endConditions)
		)
			fail("plan");
	for (const x of s.steps) {
		if (
			plans.get(x.planKey)?.projectKey !== x.projectKey ||
			!text(x.title) ||
			!text(x.code) ||
			!nullableText(x.originalCode) ||
			!Number.isFinite(x.order) ||
			typeof x.required !== "boolean" ||
			!statuses.includes(x.status) ||
			!text(x.acceptance) ||
			!text(x.sync) ||
			!text(x.updatedAt) ||
			!Array.isArray(x.conditions) ||
			!Array.isArray(x.evidence) ||
			!Array.isArray(x.blockers) ||
			!strings(x.dependsOn) ||
			x.dependsOn.some((k) => steps.get(k)?.planKey !== x.planKey) ||
			(x.parentKey !== null && steps.get(x.parentKey)?.planKey !== x.planKey)
		)
			fail("step");
		if (x.bindingKey !== null && !s.bindings.some((b) => b.key === x.bindingKey && b.planKey === x.planKey))
			fail("binding reference");
		if (x.executionKey !== null && !s.executions.some((b) => b.key === x.executionKey && b.planKey === x.planKey))
			fail("execution reference");
		for (const b of x.blockers)
			if (
				!object(b) ||
				!text(b.blockerId) ||
				!text(b.reason) ||
				!strings(b.waitingFor) ||
				!strings(b.releaseConditions) ||
				typeof b.resolved !== "boolean"
			)
				fail("blocker");
	}
	for (const r of s.routes)
		if (
			plans.get(r.planKey)?.projectKey !== r.projectKey ||
			!text(r.label) ||
			!Number.isFinite(r.order) ||
			!strings(r.stepKeys) ||
			r.stepKeys.some((k) => steps.get(k)?.planKey !== r.planKey) ||
			!validContext(r.context) ||
			!nullableText(r.sourceStepKey) ||
			!nullableText(r.returnStepKey) ||
			[r.sourceStepKey, r.returnStepKey].some((k) => k !== null && !steps.has(k))
		)
			fail("route");
	for (const b of s.bindings)
		if (
			plans.get(b.planKey)?.projectKey !== b.projectKey ||
			!strings(b.stepKeys) ||
			b.stepKeys.some((k) => steps.get(k)?.planKey !== b.planKey) ||
			!validContext(b.context) ||
			!text(b.state) ||
			!revision(b.bindingRevision)
		)
			fail("binding");
	for (const x of s.executions)
		if (
			plans.get(x.planKey)?.projectKey !== x.projectKey ||
			!strings(x.stepKeys) ||
			x.stepKeys.some((k) => steps.get(k)?.planKey !== x.planKey) ||
			!nullableText(x.outcome) ||
			(x.bindingKey !== null && !s.bindings.some((b) => b.key === x.bindingKey && b.planKey === x.planKey))
		)
			fail("execution");
	for (const x of s.supplements)
		if (
			!steps.has(x.sourceStepKey) ||
			!text(x.title) ||
			!text(x.goal) ||
			typeof x.blocksSource !== "boolean" ||
			!text(x.status) ||
			(x.linkedPlanKey !== null && !plans.has(x.linkedPlanKey))
		)
			fail("supplement");
	const assertAcyclic = (keys: string[], next: (key: string) => string[]) => {
		const active = new Set<string>();
		const visited = new Set<string>();
		const visit = (key: string) => {
			if (active.has(key)) fail("cyclic presentation relation");
			if (visited.has(key)) return;
			active.add(key);
			for (const child of next(key)) visit(child);
			active.delete(key);
			visited.add(key);
		};
		for (const key of keys) visit(key);
	};
	assertAcyclic([...steps.keys()], (key) => {
		const parent = steps.get(key)?.parentKey;
		return parent ? [parent] : [];
	});
	assertAcyclic([...plans.keys()], (key) =>
		s.supplements
			.filter((x) => steps.get(x.sourceStepKey)?.planKey === key && x.linkedPlanKey)
			.map((x) => x.linkedPlanKey as string),
	);
	if (!Array.isArray(s.events)) fail("events");
	for (const x of s.events)
		if (
			!object(x) ||
			!text(x.eventId) ||
			!text(x.reason) ||
			!text(x.occurredAt) ||
			!text(x.receivedAt) ||
			(x.toStatus !== null && !statuses.includes(x.toStatus)) ||
			(x.stepKey !== null && !steps.has(x.stepKey)) ||
			(x.executionKey !== null && !s.executions.some((e) => e.key === x.executionKey))
		)
			fail("event");
	if (new Set(s.events.map((x) => x.eventId)).size !== s.events.length) fail("duplicate event");
	return structuredClone(e);
}

// Ignore out-of-order reads; an error preserves the last valid snapshot, never mock fallback.
export function acceptEnvelope(current: WorkbenchEnvelope | null, incoming: unknown): WorkbenchEnvelope {
	const next = validateEnvelope(incoming);
	if (current && current.mode !== next.mode) fail("mode cannot change implicitly");
	if (!current?.snapshot) return next;
	const a = current.snapshot.revision;
	const b = next.snapshot?.revision;
	if (!next.snapshot || (a !== null && b !== null && b !== undefined && b < a)) {
		return {
			...next,
			snapshot: structuredClone(current.snapshot),
			connection: {
				...next.connection,
				state: next.connection.state === "ready" ? "stale" : next.connection.state,
				lastSuccessAt: current.connection.lastSuccessAt,
				message: next.connection.state === "ready" ? "Ignored an older snapshot revision." : next.connection.message,
			},
		};
	}
	return next;
}
