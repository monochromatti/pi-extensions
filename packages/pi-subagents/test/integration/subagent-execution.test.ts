import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { MockPi } from "../support/helpers.ts";
import {
	createEventBus,
	createMockPi,
	createTempDir,
	makeAgent,
	makeAgentConfigs,
	makeMinimalCtx,
	removeTempDir,
	tryImport,
} from "../support/helpers.ts";

interface SingleResult {
	exitCode: number;
	agent: string;
	messages: unknown[];
	finalOutput?: string;
}

interface ExecutionModule {
	runSync(runtimeCwd: string, agents: ReturnType<typeof makeAgentConfigs>, agentName: string, task: string, options: Record<string, unknown>): Promise<SingleResult>;
}

interface UtilsModule {
	getFinalOutput(messages: unknown[]): string;
}

interface ExecutorModule {
	createSubagentExecutor(deps: Record<string, unknown>): {
		execute(id: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: undefined, ctx: ReturnType<typeof makeMinimalCtx>): Promise<{ isError?: boolean; content: Array<{ text?: string }>; details?: { mode?: string; runId?: string; asyncId?: string; asyncDir?: string; results?: Array<{ agent: string; finalOutput?: string; exitCode?: number }> } }>;
	};
}

interface AsyncExecutionModule {
	isAsyncAvailable(): boolean;
}

interface TypesModule {
	ASYNC_DIR: string;
}

const execution = await tryImport<ExecutionModule>("./src/runs/foreground/execution.ts");
const utils = await tryImport<UtilsModule>("./src/shared/utils.ts");
const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
const asyncExecution = await tryImport<AsyncExecutionModule>("./src/runs/background/async-execution.ts");
const types = await tryImport<TypesModule>("./src/shared/types.ts");
const available = Boolean(execution && utils && executorMod && types);

function readCalls(mockPi: MockPi): Array<{ args: string[] }> {
	return fs.readdirSync(mockPi.dir)
		.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
		.sort()
		.map((name) => JSON.parse(fs.readFileSync(path.join(mockPi.dir, name), "utf-8")) as { args: string[] });
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: T | undefined;
	while (Date.now() < deadline) {
		last = await read();
		if (last !== undefined) return last;
		await delay(50);
	}
	assert.fail(`Timed out waiting for condition. Last value: ${JSON.stringify(last)}`);
}

async function withIntercomBridgeHome<T>(dir: string, fn: () => Promise<T>): Promise<T> {
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = dir;
	process.env.USERPROFILE = dir;
	fs.mkdirSync(path.join(dir, ".pi", "agent", "extensions", "pi-intercom"), { recursive: true });
	try {
		return await fn();
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
	}
}

describe("subagent execution integration with mock pi", { skip: !available ? "pi execution modules not importable" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir();
		mockPi.reset();
	});

	afterEach(() => removeTempDir(tempDir));

	function makeExecutor(agents = [makeAgent("worker"), makeAgent("reviewer")], config: Record<string, unknown> = {}, overrides: { events?: ReturnType<typeof createEventBus>; state?: Record<string, unknown> } = {}) {
		return executorMod!.createSubagentExecutor({
			pi: { events: overrides.events ?? createEventBus(), getSessionName: () => "parent-session" },
			state: overrides.state ?? { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), foregroundRuns: new Map(), foregroundControls: new Map(), lastForegroundControlId: null },
			config,
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents }),
		});
	}

	it("3.1/3.2 single child spawn returns mock output", async () => {
		mockPi.onCall({ output: "single mock output" });
		const agents = makeAgentConfigs(["worker"]);

		const result = await execution!.runSync(tempDir, agents, "worker", "Say hi", { runId: "single-run", index: 0 });

		assert.equal(result.exitCode, 0);
		assert.equal(result.agent, "worker");
		assert.equal(utils!.getFinalOutput(result.messages), "single mock output");
		assert.equal(mockPi.callCount(), 1);
		assert.equal(readCalls(mockPi)[0]?.args.at(-1), "Task: Say hi");
	});

	it("4.1/4.2 parallel child spawn returns stable ordered outputs", async () => {
		mockPi.onCall({ output: "first output", delay: 30 });
		mockPi.onCall({ output: "second output", delay: 1 });
		const executor = makeExecutor([makeAgent("worker"), makeAgent("reviewer")]);

		const result = await executor.execute(
			"parallel-run",
			{ tasks: [{ agent: "worker", task: "First" }, { agent: "reviewer", task: "Second" }], concurrency: 1 },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.equal(mockPi.callCount(), 2);
		assert.deepEqual(result.details?.results?.map((entry) => entry.agent), ["worker", "reviewer"]);
		assert.match(result.details?.results?.[0]?.finalOutput ?? "", /first output/);
		assert.match(result.details?.results?.[1]?.finalOutput ?? "", /second output/);
		assert.match(result.content[0]?.text ?? "", /worker/);
		assert.match(result.content[0]?.text ?? "", /reviewer/);
	});

	it("3.7/3.8 child env metadata is observable by mock child", async () => {
		mockPi.onCall({ echoEnv: ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_RUN_ID", "PI_SUBAGENT_CHILD_AGENT", "PI_SUBAGENT_CHILD_INDEX", "PI_SUBAGENT_ORCHESTRATOR_TARGET"] });
		const agents = makeAgentConfigs(["worker"]);

		const result = await execution!.runSync(tempDir, agents, "worker", "Show env", {
			runId: "env-run",
			index: 7,
			orchestratorIntercomTarget: "parent-session",
		});

		const env = JSON.parse(utils!.getFinalOutput(result.messages)) as Record<string, string | null>;
		assert.equal(env.PI_SUBAGENT_CHILD, "1");
		assert.equal(env.PI_SUBAGENT_RUN_ID, "env-run");
		assert.equal(env.PI_SUBAGENT_CHILD_AGENT, "worker");
		assert.equal(env.PI_SUBAGENT_CHILD_INDEX, "7");
		assert.equal(env.PI_SUBAGENT_ORCHESTRATOR_TARGET, "parent-session");
	});

	it("9.1/9.2 parent subagent run sets supervisor target env from parent intercom target", async () => {
		await withIntercomBridgeHome(tempDir, async () => {
			mockPi.onCall({ echoEnv: ["PI_SUBAGENT_ORCHESTRATOR_TARGET", "PI_SUBAGENT_INTERCOM_SESSION_NAME", "PI_SUBAGENT_CHILD_AGENT", "PI_SUBAGENT_CHILD_INDEX"] });
			const executor = makeExecutor([makeAgent("worker")], { intercomBridge: { mode: "always" } });

			const result = await executor.execute(
				"bridge-env-run",
				{ agent: "worker", task: "Show bridge env" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			const env = JSON.parse(result.details?.results?.[0]?.finalOutput ?? "{}") as Record<string, string | null>;
			assert.equal(env.PI_SUBAGENT_ORCHESTRATOR_TARGET, "parent-session");
			assert.match(env.PI_SUBAGENT_INTERCOM_SESSION_NAME ?? "", /^subagent-worker-[a-z0-9-]+-1$/);
			assert.equal(env.PI_SUBAGENT_CHILD_AGENT, "worker");
			assert.equal(env.PI_SUBAGENT_CHILD_INDEX, "0");
		});
	});

	it("9.3/9.4 foreground execution stays alive while child is in contact_supervisor tool call", async () => {
		await withIntercomBridgeHome(tempDir, async () => {
			mockPi.onCall({
				steps: [
					{ jsonl: [{ type: "tool_execution_start", toolName: "contact_supervisor", args: { reason: "need_decision", message: "Need decision" } }] },
					{ delay: 250, jsonl: [{ type: "tool_execution_end", toolName: "contact_supervisor" }] },
					{ jsonl: [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "completed after supervisor reply" }], model: "mock/test-model", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } }] },
				],
			});
			const executor = makeExecutor([
				makeAgent("worker", { systemPrompt: "Intercom orchestration channel:\nUse contact_supervisor for supervisor decisions." }),
			], { intercomBridge: { mode: "always" } });

			const startedAt = Date.now();
			const result = await executor.execute(
				"bridge-blocked-run",
				{ agent: "worker", task: "Need supervisor" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined);
			assert.ok(Date.now() - startedAt >= 200, "foreground run should wait for child after contact_supervisor starts");
			assert.match(result.details?.results?.[0]?.finalOutput ?? "", /completed after supervisor reply/);
		});
	});

	it("5.5/5.6 embedded parallel chain feeds combined result into next step", async () => {
		mockPi.onCall({ output: "seed output" });
		mockPi.onCall({ output: "left branch output" });
		mockPi.onCall({ output: "right branch output" });
		mockPi.onCall({ output: "final output" });
		const executor = makeExecutor([makeAgent("planner"), makeAgent("worker"), makeAgent("reviewer"), makeAgent("summarizer")]);

		const result = await executor.execute(
			"chain-parallel-run",
			{
				task: "initial request",
				chain: [
					{ agent: "planner", task: "Plan {task}" },
					{
						parallel: [
							{ agent: "worker", task: "Analyze from {previous}" },
							{ agent: "reviewer", task: "Review from {previous}" },
						],
						concurrency: 1,
					},
					{ agent: "summarizer", task: "Summarize combined: {previous}" },
				],
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, result.content[0]?.text ?? "");
		assert.equal(mockPi.callCount(), 4);
		assert.deepEqual(result.details?.results?.map((entry) => entry.agent), ["planner", "worker", "reviewer", "summarizer"]);
		const calls = readCalls(mockPi);
		assert.match(calls[1]?.args.at(-1) ?? "", /seed output/);
		assert.match(calls[2]?.args.at(-1) ?? "", /seed output/);
		assert.match(calls[3]?.args.at(-1) ?? "", /left branch output/);
		assert.match(calls[3]?.args.at(-1) ?? "", /right branch output/);
		assert.match(result.content[0]?.text ?? "", /final output/);
	});

	it("6.1/6.4 async single start returns id and status reports running or completed output", { skip: !asyncExecution?.isAsyncAvailable() ? "async jiti runtime unavailable" : undefined }, async () => {
		mockPi.onCall({ output: "async done", keepAliveAfterFinalMessageMs: 500 });
		const executor = makeExecutor([makeAgent("worker")]);

		const started = await executor.execute(
			"async-tool-call",
			{ agent: "worker", task: "Slow task", async: true },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(started.isError, undefined);
		assert.equal(started.details?.mode, "single");
		assert.ok(started.details?.asyncId, "async start should expose async id");
		assert.ok(started.details?.asyncDir, "async start should expose async dir");
		assert.match(started.content[0]?.text ?? "", /Async:/);
		assert.match(started.content[0]?.text ?? "", /status/);

		const runId = started.details!.asyncId!;
		const statusResult = await waitFor(async () => {
			const result = await executor.execute(
				"async-status-call",
				{ action: "status", id: runId },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			const text = result.content[0]?.text ?? "";
			return /State: (running|completed|complete)/.test(text) ? result : undefined;
		}, 8_000);

		const statusText = statusResult.content[0]?.text ?? "";
		assert.equal(statusResult.isError, undefined);
		assert.match(statusText, new RegExp(`Run: ${runId}`));
		assert.match(statusText, /Mode: single/);
		assert.match(statusText, /State: (running|completed|complete)/);

		const completed = await waitFor(async () => {
			const result = await executor.execute(
				"async-status-complete-call",
				{ action: "status", id: runId },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);
			const text = result.content[0]?.text ?? "";
			return /State: (completed|complete)/.test(text) && /async done/.test(text) ? result : undefined;
		}, 8_000);

		assert.match(completed.content[0]?.text ?? "", /async done/);
	});

	it("6.9/6.10 async chain status summarizes flattened child indexes and logical chain steps", { skip: !asyncExecution?.isAsyncAvailable() ? "async jiti runtime unavailable" : undefined }, async () => {
		const runId = `chain-status-${Date.now()}`;
		const asyncDir = path.join(types!.ASYNC_DIR, runId);
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				mode: "chain",
				state: "running",
				startedAt: Date.now(),
				lastUpdate: Date.now(),
				currentStep: 2,
				chainStepCount: 3,
				parallelGroups: [{ start: 1, count: 2, stepIndex: 1 }],
				steps: [
					{ agent: "planner", status: "complete" },
					{ agent: "worker", status: "complete" },
					{ agent: "reviewer", status: "running" },
					{ agent: "summarizer", status: "pending" },
				],
			}, null, 2), "utf-8");
			const state = { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map([[runId, { asyncId: runId, asyncDir, status: "running", updatedAt: Date.now() }]]), foregroundRuns: new Map(), foregroundControls: new Map(), lastForegroundControlId: null };
			const executor = makeExecutor([makeAgent("planner"), makeAgent("worker"), makeAgent("reviewer"), makeAgent("summarizer")], {}, { state });

			const result = await executor.execute(
				"async-chain-status-call",
				{ action: "status", id: runId },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			const statusText = result.content[0]?.text ?? "";
			assert.equal(result.isError, undefined, statusText);
			assert.match(statusText, new RegExp(`Run: ${runId}`));
			assert.match(statusText, /Mode: chain/);
			assert.match(statusText, /Progress: step 2\/3 · parallel group:/);
			assert.match(statusText, /Step 1\/3: planner complete/);
			assert.match(statusText, /Step 2\/3 Agent 1\/2: worker complete/);
			assert.match(statusText, /Step 2\/3 Agent 2\/2: reviewer running/);
			assert.match(statusText, /Step 3\/3: summarizer pending/);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("6.9/6.10 async parallel status summarizes all child indexes", { skip: !asyncExecution?.isAsyncAvailable() ? "async jiti runtime unavailable" : undefined }, async () => {
		const runId = `parallel-status-${Date.now()}`;
		const asyncDir = path.join(types!.ASYNC_DIR, runId);
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				mode: "parallel",
				state: "running",
				startedAt: Date.now(),
				lastUpdate: Date.now(),
				steps: [
					{ agent: "worker", status: "running" },
					{ agent: "reviewer", status: "pending" },
				],
			}, null, 2), "utf-8");
			const state = { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map([[runId, { asyncId: runId, asyncDir, status: "running", updatedAt: Date.now() }]]), foregroundRuns: new Map(), foregroundControls: new Map(), lastForegroundControlId: null };
			const executor = makeExecutor([makeAgent("worker"), makeAgent("reviewer")], {}, { state });

			const result = await executor.execute(
				"async-parallel-status-call",
				{ action: "status", id: runId },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			const statusText = result.content[0]?.text ?? "";
			assert.equal(result.isError, undefined, statusText);
			assert.match(statusText, /Mode: parallel/);
			assert.match(statusText, /Progress: /);
			assert.match(statusText, /Agent 1\/2: worker running/);
			assert.match(statusText, /Agent 2\/2: reviewer pending/);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("6.5/6.6 interrupt requests a signal for a running async child", { skip: !asyncExecution?.isAsyncAvailable() ? "async jiti runtime unavailable" : undefined }, async () => {
		const runId = `interrupt-${Date.now()}`;
		const asyncDir = path.join(types!.ASYNC_DIR, runId);
		const child = spawn("sleep", ["30"]);
		try {
			assert.ok(child.pid, "sleep child should expose pid");
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				mode: "single",
				state: "running",
				pid: child.pid,
				startedAt: Date.now(),
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}, null, 2), "utf-8");
			const state = { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map([[runId, { asyncId: runId, asyncDir, status: "running", updatedAt: Date.now() }]]), foregroundRuns: new Map(), foregroundControls: new Map(), lastForegroundControlId: null };
			const executor = makeExecutor([makeAgent("worker")], {}, { state });

			const result = await executor.execute(
				"async-interrupt-call",
				{ action: "interrupt", id: runId },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined, result.content[0]?.text ?? "");
			assert.match(result.content[0]?.text ?? "", new RegExp(`Interrupt requested for async run ${runId}`));
		} finally {
			if (child.pid) {
				try { process.kill(child.pid, "SIGKILL"); } catch {}
			}
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("6.7/6.8 resume sends a follow-up to a live async child", { skip: !asyncExecution?.isAsyncAvailable() ? "async jiti runtime unavailable" : undefined }, async () => {
		const runId = `resume-live-${Date.now()}`;
		const asyncDir = path.join(types!.ASYNC_DIR, runId);
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				mode: "single",
				state: "running",
				startedAt: Date.now(),
				lastUpdate: Date.now(),
				cwd: tempDir,
				steps: [{ agent: "worker", status: "running" }],
			}, null, 2), "utf-8");
			const emitted: Array<{ channel: string; payload: Record<string, unknown> }> = [];
			const listeners = new Map<string, Set<(payload: unknown) => void>>();
			const events = {
				on(channel: string, handler: (payload: unknown) => void) {
					const set = listeners.get(channel) ?? new Set<(payload: unknown) => void>();
					set.add(handler);
					listeners.set(channel, set);
					return () => set.delete(handler);
				},
				emit(channel: string, payload: unknown) {
					emitted.push({ channel, payload: payload as Record<string, unknown> });
					if (channel === "subagent:result-intercom") {
						const requestId = (payload as { requestId?: string }).requestId;
						for (const handler of listeners.get("subagent:result-intercom-delivery") ?? []) handler({ requestId, delivered: true });
					}
					for (const handler of listeners.get(channel) ?? []) handler(payload);
				},
			};
			const executor = makeExecutor([makeAgent("worker")], {}, { events });

			const result = await executor.execute(
				"async-resume-call",
				{ action: "resume", id: runId, message: "Please continue with detail" },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(tempDir),
			);

			assert.equal(result.isError, undefined, result.content[0]?.text ?? "");
			assert.match(result.content[0]?.text ?? "", /Delivered follow-up to live async child/);
			const payload = emitted.find((entry) => entry.channel === "subagent:result-intercom")?.payload;
			assert.equal(payload?.to, `subagent-worker-${runId}-1`);
			assert.match(String(payload?.message ?? ""), /Please continue with detail/);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});
});
