// Deterministic simulation only. Date: 2026-11-11. Never connects to a service.

import type {
	EventResult,
	Plan,
	Route,
	Step,
	StepStatus,
	WorkbenchClient,
	WorkbenchEnvelope,
	WorkbenchSnapshot,
} from "./protocol";
import { acceptEnvelope, PROTOCOL_VERSION, SNAPSHOT_VERSION } from "./protocol";
export const scenarios = [
	{ id: "multi-project", label: "多项目与五状态" },
	{ id: "long-route", label: "长路线 · 60 阶段" },
	{ id: "deep-branch", label: "深分支 · 四层关联" },
	{ id: "empty", label: "空数据" },
	{ id: "offline", label: "服务离线（模拟）" },
	{ id: "unauthorized", label: "授权拒绝（模拟）" },
	{ id: "stale", label: "过期快照（模拟）" },
	{ id: "incompatible", label: "版本不兼容（模拟）" },
	{ id: "unknown", label: "操作结果未知（模拟）" },
] as const;
export type ScenarioId = (typeof scenarios)[number]["id"];
const now = "2026-11-11T13:00:00.000Z";
const states: StepStatus[] = ["completed", "completed", "running", "blocked", "pending", "cancelled"];
const context = {
	threadId: "simulation-thread-C",
	hostId: "simulation",
	branch: "codex/simulation",
	worktreePath: "G:\\simulation\\workbench",
};
export function createSnapshot(): WorkbenchSnapshot {
	const s: WorkbenchSnapshot = {
		schemaVersion: SNAPSHOT_VERSION,
		date: "2026-11-11",
		mode: "simulation",
		revision: 10,
		generatedAt: now,
		projects: [],
		plans: [],
		steps: [],
		routes: [],
		bindings: [],
		executions: [],
		supplements: [],
		events: [],
	};
	const addPlan = (
		projectKey: string,
		key: string,
		name: string,
		count: number,
		routeCount = 1,
		sourceStepKey: string | null = null,
	): Plan => {
		const plan: Plan = {
			key,
			id: null,
			projectKey,
			name,
			stageCount: count,
			stageKeys: [],
			source: {
				path: `simulation://${key}`,
				version: "2026-11-11",
				sha256: "0".repeat(64),
				locator: name,
				trust: "declared",
			},
			endConditions: [],
		};
		s.plans.push(plan);
		s.projects.find((p) => p.key === projectKey)?.planKeys.push(key);
		for (let i = 0; i < count; i++) {
			const stepKey = `${key}/step/${i + 1}`;
			plan.stageKeys.push(stepKey);
			const status = states[i % states.length];
			const step: Step = {
				key: stepKey,
				id: null,
				projectKey,
				planKey: key,
				parentKey: null,
				code: `C-${String(i + 1).padStart(2, "0")}`,
				originalCode: `C-${String(i + 1).padStart(2, "0")}`,
				title: [
					"契约与版本核对",
					"模拟数据与授权边界",
					"工作台视图开发",
					"原生焦点待核验",
					"恢复与交付检查",
					"已取消的替代方案",
				][i % 6],
				order: i + 1,
				required: true,
				dependsOn: i ? [`${key}/step/${i}`] : [],
				status,
				acceptance: status === "completed" ? "passed" : "pending",
				sync: "simulation",
				conditions: [
					{
						conditionId: `${stepKey}/exit`,
						text: "固定 ID、交互及证据可追溯",
						required: true,
						result: status === "completed" ? "passed" : "pending",
						evidenceIds: [],
					},
				],
				evidence: [],
				blockers:
					status === "blocked"
						? [
								{
									blockerId: `${stepKey}/wait`,
									reason: "等待原生环境核验",
									waitingFor: ["原生桌面"],
									releaseConditions: ["提供当前版本证据"],
									resolved: false,
								},
							]
						: [],
				bindingKey: null,
				executionKey: null,
				updatedAt: now,
			};
			s.steps.push(step);
		}
		for (let j = 0; j < routeCount; j++) {
			const route: Route = {
				key: `${key}/route/${j + 1}`,
				id: null,
				projectKey,
				planKey: key,
				label: routeCount === 1 ? "主路线" : `路线 ${j + 1}`,
				stepKeys: plan.stageKeys.slice(
					Math.floor((j * count) / routeCount),
					Math.floor(((j + 1) * count) / routeCount),
				),
				order: j + 1,
				context: { ...context },
				sourceStepKey: j === 0 ? sourceStepKey : null,
				returnStepKey: null,
			};
			if (route.stepKeys.length) s.routes.push(route);
		}
		return plan;
	};
	for (const [key, name] of [
		["sim/project/workbench", "灵动岛工作台"],
		["sim/project/standards", "建筑规范知识库"],
		["sim/project/cad", "CADTools"],
	])
		s.projects.push({ key, id: null, name, planKeys: [], revision: 10 });
	const main = addPlan(s.projects[0].key, "sim/plan/main", "二十阶段 · 六路线", 20, 6);
	addPlan(s.projects[1].key, "sim/plan/long", "长路线压力样例", 60);
	addPlan(s.projects[2].key, "sim/plan/cad", "独立工具路线", 6);
	let source = main.stageKeys[2];
	for (let depth = 1; depth <= 4; depth++) {
		const branch = addPlan(s.projects[0].key, `sim/plan/branch/${depth}`, `深分支 ${depth} · 恢复与证据`, 3, 1, source);
		s.supplements.push({
			key: `sim/supplement/${depth}`,
			id: null,
			sourceStepKey: source,
			title: `补充事项 ${depth}`,
			goal: "模拟关联分支，不修改正式业务",
			blocksSource: true,
			status: "running",
			linkedPlanKey: branch.key,
			repairId: null,
		});
		source = branch.stageKeys[1];
	}
	const childKey = `${main.stageKeys[2]}/child`;
	s.steps.push({
		...structuredClone(s.steps[2]),
		key: childKey,
		parentKey: main.stageKeys[2],
		code: "C-03-01",
		originalCode: "C-03-01",
		title: "视图内部细分任务",
		order: 1,
		dependsOn: [],
		bindingKey: "sim/binding/C",
		executionKey: "sim/execution/C",
	});
	s.bindings.push({
		key: "sim/binding/C",
		id: null,
		projectKey: main.projectKey,
		planKey: main.key,
		stepKeys: [main.stageKeys[2], childKey],
		state: "declared",
		bindingRevision: null,
		context: { ...context },
	});
	s.executions.push({
		key: "sim/execution/C",
		id: null,
		projectKey: main.projectKey,
		planKey: main.key,
		stepKeys: [main.stageKeys[2], childKey],
		bindingKey: "sim/binding/C",
		outcome: null,
	});
	s.steps[2].bindingKey = "sim/binding/C";
	s.steps[2].executionKey = "sim/execution/C";
	s.events.push({
		eventId: "sim/event/blocked",
		stepKey: main.stageKeys[3],
		executionKey: null,
		reason: "等待原生环境核验",
		occurredAt: now,
		receivedAt: now,
		toStatus: "blocked",
	});
	return s;
}
export function createScenario(id: ScenarioId): WorkbenchEnvelope {
	const s = createSnapshot();
	const e: WorkbenchEnvelope = {
		protocolVersion: PROTOCOL_VERSION,
		mode: "simulation",
		snapshot: s,
		capabilities: {
			threadJump: false,
			worktreeOpen: false,
			businessWrite: false,
			reason: "模拟模式不执行宿主或业务操作；可复制固定标识与路径。",
		},
		connection: { state: "ready", healthy: true, lastSuccessAt: now, message: "模拟快照 · 不连接正式服务" },
		pendingOperation: null,
	};
	if (id === "long-route" || id === "deep-branch") {
		const projectKey = id === "long-route" ? "sim/project/standards" : "sim/project/workbench";
		s.projects = s.projects.filter((x) => x.key === projectKey);
		s.plans = s.plans.filter((x) => x.projectKey === projectKey);
		s.steps = s.steps.filter((x) => x.projectKey === projectKey);
		s.routes = s.routes.filter((x) => x.projectKey === projectKey);
		s.bindings = s.bindings.filter((x) => x.projectKey === projectKey);
		s.executions = s.executions.filter((x) => x.projectKey === projectKey);
		const keys = new Set(s.steps.map((x) => x.key));
		s.supplements = s.supplements.filter((x) => keys.has(x.sourceStepKey));
		s.events = s.events.filter((x) => x.stepKey === null || keys.has(x.stepKey));
	}
	if (id === "empty") {
		s.projects = [];
		s.plans = [];
		s.steps = [];
		s.routes = [];
		s.bindings = [];
		s.executions = [];
		s.supplements = [];
		s.events = [];
	}
	if (id === "offline" || id === "unauthorized" || id === "incompatible") {
		e.snapshot = null;
		e.connection = {
			state: id,
			healthy: false,
			lastSuccessAt: null,
			message: {
				offline: "模拟服务离线，请重连；最后成功快照保留并视为过期。",
				unauthorized: "模拟授权已拒绝；请在受控入口恢复授权。",
				incompatible: "模拟远端协议 island-workbench/2 不兼容；未解析或套用新数据。",
			}[id],
		};
	}
	if (id === "stale")
		e.connection = {
			state: "stale",
			healthy: true,
			lastSuccessAt: now,
			message: "模拟旧快照；请刷新，禁止依赖实时状态的操作。",
		};
	if (id === "unknown") {
		e.pendingOperation = {
			eventId: "sim/event/unknown-result",
			state: "unknown",
			reason: "模拟响应丢失；使用同一事件键查询，不重复提交。",
		};
		e.connection.message = "连接正常；操作提交结果未知，与服务离线分别显示。";
	}
	return e;
}
export class MockWorkbenchClient implements WorkbenchClient {
	readonly mode = "simulation" as const;
	private scenario: ScenarioId;
	private current: WorkbenchEnvelope | null = null;
	private result: EventResult | null = null;
	constructor(initial: ScenarioId = "multi-project") {
		this.scenario = initial;
	}
	selectScenario(id: ScenarioId): void {
		if (!scenarios.some((x) => x.id === id)) throw new Error("UNKNOWN_SIMULATION_SCENARIO");
		this.scenario = id;
		this.result = null;
	}
	async read(): Promise<WorkbenchEnvelope> {
		const incoming = createScenario(this.scenario);
		if (this.result?.state === "committed") incoming.pendingOperation = null;
		this.current = acceptEnvelope(this.current, incoming);
		return structuredClone(this.current);
	}
	async queryEvent(eventId: string): Promise<EventResult> {
		if (this.scenario !== "unknown" || eventId !== "sim/event/unknown-result")
			return { eventId, state: "notFound", committedRevision: null };
		this.result ??= { eventId, state: "committed", committedRevision: 10 };
		return structuredClone(this.result);
	}
}
