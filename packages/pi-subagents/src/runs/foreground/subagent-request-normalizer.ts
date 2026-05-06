import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { AgentConfig } from "../../agents/agents.ts";
import { validateSubagentParams } from "../../extension/schemas.ts";
import { applyForceTopLevelAsyncOverride } from "../background/top-level-async.ts";
import {
	getStepAgents,
	isParallelStep,
	type ChainStep,
	type SequentialStep,
} from "../../shared/settings.ts";
import {
	type Details,
	type MaxOutputConfig,
	type ControlConfig,
} from "../../shared/types.ts";
import type { SubagentParamsLike, TaskParam } from "./subagent-request-types.ts";

export type { SubagentParamsLike, TaskParam } from "./subagent-request-types.ts";

export interface NormalizedRequestBase {
	params: SubagentParamsLike;
	requestedCwd: string;
	effectiveCwd: string;
	context?: "fresh" | "fork";
}

export interface NormalizedStatusRequest extends NormalizedRequestBase {
	kind: "status";
	id?: string;
	runId?: string;
	dir?: string;
}
export interface NormalizedInterruptRequest extends NormalizedRequestBase {
	kind: "interrupt";
	targetRunId?: string;
}
export interface NormalizedResumeRequest extends NormalizedRequestBase {
	kind: "resume";
	id?: string;
	runId?: string;
	index?: number;
}
export type NormalizedControlRequest = NormalizedStatusRequest | NormalizedInterruptRequest | NormalizedResumeRequest;

export interface SurfaceRunRequest extends NormalizedRequestBase {
	kind: "run-surface";
}
export type SurfaceRequest = NormalizedControlRequest | SurfaceRunRequest;

export interface NormalizedRunBaseRequest extends NormalizedRequestBase {
	kind: "run";
	mode: "single" | "parallel" | "chain";
	effectiveAsync: boolean;
	shareEnabled: boolean;
	control?: ControlConfig;
	sessionDir?: string;
	maxOutput?: MaxOutputConfig;
	includeProgress?: boolean;
}
export interface NormalizedSingleRunRequest extends NormalizedRunBaseRequest {
	mode: "single";
	agent: string;
	task: string;
	model?: string;
	skill?: string | string[] | boolean;
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
}
export interface NormalizedParallelRunRequest extends NormalizedRunBaseRequest {
	mode: "parallel";
	tasks: TaskParam[];
	concurrency?: number;
}
export interface NormalizedChainRunRequest extends NormalizedRunBaseRequest {
	mode: "chain";
	chain: ChainStep[];
	task?: string;
	skill?: string | string[] | boolean;
}
export type NormalizedRunRequest = NormalizedSingleRunRequest | NormalizedParallelRunRequest | NormalizedChainRunRequest;

export interface NormalizedRunShape extends NormalizedRequestBase {
	kind: "run-shape";
	mode: "single" | "parallel" | "chain";
	effectiveAsync: boolean;
	shareEnabled: boolean;
}

type NormResult<T> = { ok: true; request: T } | { ok: false; result: AgentToolResult<Details> };

export function normalizeSubagentSurfaceRequest(input: { rawParams: SubagentParamsLike; runtimeCwd: string }): NormResult<SurfaceRequest> {
	const validation = validateSubagentParams(input.rawParams);
	if (!validation.ok) return { ok: false, result: { content: [{ type: "text", text: validation.error ?? "Invalid subagent parameters" }], isError: true, details: { mode: "single", results: [] } } };
	const requestedCwd = input.rawParams.cwd ? path.resolve(input.runtimeCwd, input.rawParams.cwd) : input.runtimeCwd;
	const params = input.rawParams.cwd === undefined ? input.rawParams : { ...input.rawParams, cwd: requestedCwd };
	const base = { params, requestedCwd, effectiveCwd: params.cwd ?? input.runtimeCwd, context: params.context };
	if (params.action === "status") return { ok: true, request: { ...base, kind: "status", id: params.id, runId: params.runId, dir: params.dir } };
	if (params.action === "interrupt") return { ok: true, request: { ...base, kind: "interrupt", targetRunId: params.runId ?? params.id } };
	if (params.action === "resume") return { ok: true, request: { ...base, kind: "resume", id: params.id, runId: params.runId, index: params.index } };
	return { ok: true, request: { ...base, kind: "run-surface" } };
}

export function getRequestedModeLabel(params: SubagentParamsLike): Details["mode"] {
	if ((params.chain?.length ?? 0) > 0) return "chain";
	if ((params.tasks?.length ?? 0) > 0) return "parallel";
	if (params.agent) return "single";
	return "single";
}

function withForkContext(result: AgentToolResult<Details>, context: SubagentParamsLike["context"]): AgentToolResult<Details> {
	if (context !== "fork" || !result.details) return result;
	return { ...result, details: { ...result.details, context: "fork" } };
}

function buildRequestedModeError(params: SubagentParamsLike, message: string): AgentToolResult<Details> {
	return withForkContext({ content: [{ type: "text", text: message }], isError: true, details: { mode: getRequestedModeLabel(params), results: [] } }, params.context);
}

export function applyAgentDefaultContext(params: SubagentParamsLike, agents: AgentConfig[]): SubagentParamsLike {
	if (params.context !== undefined) return params;
	const byName = new Map(agents.map((agent) => [agent.name, agent]));
	const names: string[] = [];
	if (params.agent) names.push(params.agent);
	for (const task of params.tasks ?? []) names.push(task.agent);
	for (const step of params.chain ?? []) names.push(...getStepAgents(step));
	return names.some((name) => byName.get(name)?.defaultContext === "fork") ? { ...params, context: "fork" } : params;
}

export function expandTopLevelTaskCounts(tasks: TaskParam[]): { tasks?: TaskParam[]; error?: string } {
	const expanded: TaskParam[] = [];
	for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
		const task = tasks[taskIndex]!;
		const rawCount = (task as TaskParam & { count?: unknown }).count;
		if (rawCount !== undefined && (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1)) return { error: `tasks[${taskIndex}].count must be an integer >= 1` };
		const { count, ...concreteTask } = task;
		for (let repeat = 0; repeat < (rawCount ?? 1); repeat++) expanded.push({ ...concreteTask });
	}
	return { tasks: expanded };
}

function expandChainParallelCounts(chain: ChainStep[]): { chain?: ChainStep[]; error?: string } {
	const expandedChain: ChainStep[] = [];
	for (let stepIndex = 0; stepIndex < chain.length; stepIndex++) {
		const step = chain[stepIndex]!;
		if (!isParallelStep(step)) { expandedChain.push(step); continue; }
		const expandedParallel = [];
		for (let taskIndex = 0; taskIndex < step.parallel.length; taskIndex++) {
			const task = step.parallel[taskIndex]!;
			const rawCount = (task as typeof task & { count?: unknown }).count;
			if (rawCount !== undefined && (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1)) return { error: `chain[${stepIndex}].parallel[${taskIndex}].count must be an integer >= 1` };
			const { count, ...concreteTask } = task;
			for (let repeat = 0; repeat < (rawCount ?? 1); repeat++) expandedParallel.push({ ...concreteTask });
		}
		expandedChain.push({ ...step, parallel: expandedParallel });
	}
	return { chain: expandedChain };
}

export function normalizeRepeatedParallelCounts(params: SubagentParamsLike): { params?: SubagentParamsLike; error?: AgentToolResult<Details> } {
	if (params.tasks) {
		const expandedTasks = expandTopLevelTaskCounts(params.tasks);
		if (expandedTasks.error) return { error: buildRequestedModeError(params, expandedTasks.error) };
		return { params: { ...params, tasks: expandedTasks.tasks } };
	}
	if (params.chain) {
		const expandedChain = expandChainParallelCounts(params.chain);
		if (expandedChain.error) return { error: buildRequestedModeError(params, expandedChain.error) };
		return { params: { ...params, chain: expandedChain.chain } };
	}
	return { params };
}

export function normalizeSubagentRunShape(input: { surface: SurfaceRunRequest; depth: number; asyncByDefault: boolean; forceTopLevelAsync: boolean }): NormResult<NormalizedRunShape> {
	const counted = normalizeRepeatedParallelCounts(input.surface.params);
	if (counted.error) return { ok: false, result: counted.error };
	const params = applyForceTopLevelAsyncOverride(counted.params!, input.depth, input.forceTopLevelAsync);
	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = !hasChain && !hasTasks && Boolean(params.agent);
	const mode = hasChain ? "chain" : hasTasks ? "parallel" : hasSingle ? "single" : undefined;
	return { ok: true, request: { ...input.surface, kind: "run-shape", params, context: params.context, effectiveCwd: params.cwd ?? input.surface.requestedCwd, mode: mode ?? "single", effectiveAsync: params.async ?? input.asyncByDefault, shareEnabled: params.share === true } };
}

export function applyDefaultContextToRunShape(shape: NormalizedRunShape, agents: AgentConfig[]): NormalizedRunShape {
	const params = applyAgentDefaultContext(shape.params, agents);
	return { ...shape, params, context: params.context, effectiveCwd: params.cwd ?? shape.requestedCwd };
}

function executionError(params: SubagentParamsLike, mode: Details["mode"], message: string): AgentToolResult<Details> {
	return { content: [{ type: "text", text: message }], isError: true, details: { mode, results: [] } };
}

export function validateSubagentRunRequest(input: { shape: NormalizedRunShape; executionAgents: AgentConfig[] }): NormResult<NormalizedRunRequest> {
	const params = input.shape.params;
	const agents = input.executionAgents;
	const hasChain = (params.chain?.length ?? 0) > 0;
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = !hasChain && !hasTasks && Boolean(params.agent);
	if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1) {
		return { ok: false, result: executionError(params, "single", `Provide exactly one mode. Agents: ${agents.map((a) => a.name).join(", ") || "none"}`) };
	}
	if (hasSingle && params.agent && !agents.find((agent) => agent.name === params.agent)) return { ok: false, result: executionError(params, "single", `Unknown agent: ${params.agent}`) };
	if (hasTasks && params.tasks) {
		for (let i = 0; i < params.tasks.length; i++) if (!agents.find((agent) => agent.name === params.tasks![i]!.agent)) return { ok: false, result: executionError(params, "parallel", `Unknown agent: ${params.tasks[i]!.agent} (task ${i + 1})`) };
	}
	if (hasChain && params.chain) {
		if (params.chain.length === 0) return { ok: false, result: executionError(params, "chain", "Chain must have at least one step") };
		const firstStep = params.chain[0] as ChainStep;
		if (isParallelStep(firstStep)) {
			const missingTaskIndex = firstStep.parallel.findIndex((t) => !t.task);
			if (missingTaskIndex !== -1) return { ok: false, result: executionError(params, "chain", `First parallel step: task ${missingTaskIndex + 1} must have a task (no previous output to reference)`) };
		} else if (!(firstStep as SequentialStep).task && !params.task) return { ok: false, result: executionError(params, "chain", "First step in chain must have a task") };
		for (let i = 0; i < params.chain.length; i++) {
			const step = params.chain[i] as ChainStep;
			for (const agentName of getStepAgents(step)) if (!agents.find((a) => a.name === agentName)) return { ok: false, result: executionError(params, "chain", `Unknown agent: ${agentName} (step ${i + 1})`) };
			if (isParallelStep(step) && step.parallel.length === 0) return { ok: false, result: executionError(params, "chain", `Parallel step ${i + 1} must have at least one task`) };
		}
	}
	const base = { ...input.shape, kind: "run" as const, params, effectiveCwd: params.cwd ?? input.shape.requestedCwd, context: params.context, control: params.control, sessionDir: params.sessionDir, maxOutput: params.maxOutput, includeProgress: params.includeProgress };
	if (hasTasks) return { ok: true, request: { ...base, mode: "parallel", tasks: params.tasks!, concurrency: params.concurrency } };
	if (hasChain) return { ok: true, request: { ...base, mode: "chain", chain: params.chain!, task: params.task, skill: params.skill } };
	return { ok: true, request: { ...base, mode: "single", agent: params.agent!, task: params.task ?? "", model: params.model, skill: params.skill, output: params.output, outputMode: params.outputMode } };
}
