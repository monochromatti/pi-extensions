/**
 * Minimal chain execution for pi-subagents.
 *
 * Chain support is intentionally in-memory: each step receives text from the
 * previous step through {previous}. There is no shared chain directory,
 * file-based progress contract, or chain-file template variable.
 */

import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../agents/agents.ts";
import { discoverAvailableSkills, normalizeSkillInput } from "../../agents/skills.ts";
import { toModelInfo, type ModelInfo } from "../../shared/model-info.ts";
import {
	isParallelStep,
	resolveParallelBehaviors,
	resolveStepBehavior,
	type ChainStep,
	type ResolvedStepBehavior,
} from "../../shared/settings.ts";
import { compactForegroundDetails, getSingleResultOutput, mapConcurrent, resolveChildCwd } from "../../shared/utils.ts";
import {
	type ActivityState,
	type AgentProgress,
	type ArtifactConfig,
	type ArtifactPaths,
	type ControlEvent,
	type Details,
	type IntercomEventBus,
	type ResolvedControlConfig,
	type SingleResult,
	type SupervisorIntercomTarget,
	MAX_CONCURRENCY,
	resolveChildMaxSubagentDepth,
} from "../../shared/types.ts";
import { resolveModelCandidate } from "../shared/model-fallback.ts";
import { validateFileOnlyOutputMode } from "../shared/single-output.ts";
import { runSync } from "./execution.ts";

interface ChainExecutionParams {
	chain: ChainStep[];
	task?: string;
	agents: AgentConfig[];
	ctx: ExtensionContext;
	intercomEvents?: IntercomEventBus;
	signal?: AbortSignal;
	runId: string;
	cwd?: string;
	shareEnabled: boolean;
	sessionDirForIndex: (idx?: number) => string | undefined;
	sessionFileForIndex?: (idx?: number) => string | undefined;
	artifactsDir: string;
	artifactConfig: ArtifactConfig;
	includeProgress?: boolean;
	clarify?: boolean;
	onUpdate?: (r: AgentToolResult<Details>) => void;
	onControlEvent?: (event: ControlEvent) => void;
	controlConfig: ResolvedControlConfig;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	orchestratorIntercomTarget?: string;
	orchestratorIntercomCwd?: string;
	supervisorIntercomTarget?: SupervisorIntercomTarget;
	foregroundControl?: {
		updatedAt: number;
		currentAgent?: string;
		currentIndex?: number;
		currentActivityState?: ActivityState;
		lastActivityAt?: number;
		currentTool?: string;
		currentToolStartedAt?: number;
		interrupt?: () => boolean;
	};
	chainSkills?: string[];
	maxSubagentDepth: number;
}

interface ChainExecutionResult {
	content: Array<{ type: "text"; text: string }>;
	details: Details;
	isError?: boolean;
	requestedAsync?: {
		chain: ChainStep[];
		chainSkills: string[];
	};
}

interface ChainRunState {
	results: SingleResult[];
	allProgress: AgentProgress[];
	allArtifactPaths: ArtifactPaths[];
	chainAgents: string[];
	totalSteps: number;
	artifactsDir: string;
	includeProgress?: boolean;
}

function buildDetails(state: ChainRunState, currentStepIndex?: number): Details {
	return compactForegroundDetails({
		mode: "chain",
		results: state.results,
		progress: state.includeProgress ? state.allProgress : undefined,
		artifacts: state.allArtifactPaths.length ? { dir: state.artifactsDir, files: state.allArtifactPaths } : undefined,
		chainAgents: state.chainAgents,
		totalSteps: state.totalSteps,
		currentStepIndex,
	});
}

function errorResult(message: string, state: ChainRunState, currentStepIndex?: number): ChainExecutionResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: buildDetails(state, currentStepIndex),
	};
}

export function renderChainTaskTemplate(template: string, originalTask: string, previous: string): string {
	if (template.includes("{chain_dir}")) {
		throw new Error("{chain_dir} template variable is not supported; use {previous} or explicit output files");
	}
	return template.replace(/\{task\}/g, originalTask).replace(/\{previous\}/g, previous);
}

export function resolveChainIoPath(filePath: string, stepCwd: string | undefined, topCwd: string | undefined, parentCwd: string): string {
	return path.isAbsolute(filePath) ? filePath : path.join(stepCwd ?? topCwd ?? parentCwd, filePath);
}

export function buildChainTaskWithIoInstructions(input: {
	task: string;
	behavior: Pick<ResolvedStepBehavior, "reads" | "output">;
	stepCwd?: string;
	topCwd?: string;
	parentCwd: string;
}): { task: string; outputPath?: string } {
	const prefix: string[] = [];
	if (Array.isArray(input.behavior.reads) && input.behavior.reads.length > 0) {
		prefix.push(`[Read from: ${input.behavior.reads.map((file) => resolveChainIoPath(file, input.stepCwd, input.topCwd, input.parentCwd)).join(", ")}]`);
	}
	const outputPath = typeof input.behavior.output === "string"
		? resolveChainIoPath(input.behavior.output, input.stepCwd, input.topCwd, input.parentCwd)
		: undefined;
	if (outputPath) prefix.push(`[Write to: ${outputPath}]`);
	return {
		task: prefix.length ? `${prefix.join("\n")}\n\n${input.task}` : input.task,
		outputPath,
	};
}

function summarizeResults(results: SingleResult[]): string {
	return results.map((result, index) => {
		const header = `${index + 1}. ${result.agent}${result.exitCode === 0 ? "" : ` (exit ${result.exitCode})`}`;
		const output = getSingleResultOutput(result).trim() || "(no output)";
		const error = result.error ? `\nError: ${result.error}` : "";
		return `${header}\n${output}${error}`;
	}).join("\n\n");
}

function collectResultArtifacts(state: ChainRunState, result: SingleResult): void {
	state.results.push(result);
	if (Array.isArray(result.progress)) state.allProgress.push(...result.progress);
	if (result.artifacts) state.allArtifactPaths.push(result.artifacts);
}

function findAgent(agents: AgentConfig[], name: string): AgentConfig | undefined {
	return agents.find((agent) => agent.name === name);
}

async function runChainChild(input: {
	params: ChainExecutionParams;
	state: ChainRunState;
	agentName: string;
	task: string;
	stepCwd?: string;
	behavior: ResolvedStepBehavior;
	availableModels: ModelInfo[];
	globalIndex: number;
}): Promise<SingleResult> {
	const { params, state, agentName, behavior, availableModels, globalIndex } = input;
	const agent = findAgent(params.agents, agentName);
	if (!agent) {
		return {
			agent: agentName,
			task: input.task,
			exitCode: 1,
			messages: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			error: `Unknown agent: ${agentName}`,
		};
	}
	const validationError = validateFileOnlyOutputMode(behavior.outputMode, typeof behavior.output === "string" ? behavior.output : undefined, `Chain step (${agentName})`);
	if (validationError) {
		return {
			agent: agentName,
			task: input.task,
			exitCode: 1,
			messages: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			outputMode: behavior.outputMode,
			error: validationError,
		};
	}

	const childCwd = resolveChildCwd(params.cwd ?? params.ctx.cwd, input.stepCwd);
	const prepared = buildChainTaskWithIoInstructions({
		task: input.task,
		behavior,
		stepCwd: childCwd,
		topCwd: params.cwd,
		parentCwd: params.ctx.cwd,
	});
	const effectiveModel = resolveModelCandidate(behavior.model, availableModels, params.ctx.model?.provider)
		?? resolveModelCandidate(agent.model, availableModels, params.ctx.model?.provider);
	const maxSubagentDepth = resolveChildMaxSubagentDepth(params.maxSubagentDepth, agent.maxSubagentDepth);
	const interruptController = new AbortController();
	if (params.foregroundControl) {
		params.foregroundControl.currentAgent = agentName;
		params.foregroundControl.currentIndex = globalIndex;
		params.foregroundControl.updatedAt = Date.now();
		params.foregroundControl.interrupt = () => {
			if (interruptController.signal.aborted) return false;
			interruptController.abort();
			return true;
		};
	}

	return runSync(params.ctx.cwd, params.agents, agentName, prepared.task, {
		cwd: childCwd,
		signal: params.signal,
		interruptSignal: interruptController.signal,
		allowIntercomDetach: true,
		intercomEvents: params.intercomEvents,
		onUpdate: params.onUpdate,
		onControlEvent: params.onControlEvent,
		controlConfig: params.controlConfig,
		intercomSessionName: params.childIntercomTarget?.(agentName, globalIndex),
		orchestratorIntercomTarget: params.orchestratorIntercomTarget,
		orchestratorIntercomCwd: params.orchestratorIntercomCwd,
		supervisorIntercomTarget: params.supervisorIntercomTarget,
		artifactsDir: params.artifactsDir,
		artifactConfig: params.artifactConfig,
		runId: params.runId,
		index: globalIndex,
		sessionDir: params.sessionDirForIndex(globalIndex),
		sessionFile: params.sessionFileForIndex?.(globalIndex),
		share: params.shareEnabled,
		outputPath: prepared.outputPath,
		outputMode: behavior.outputMode,
		modelOverride: effectiveModel,
		thinkingOverride: behavior.thinking,
		availableModels,
		preferredModelProvider: params.ctx.model?.provider,
		skills: behavior.skills === false ? [] : behavior.skills ?? [],
		maxSubagentDepth,
	});
}

export async function executeChain(params: ChainExecutionParams): Promise<ChainExecutionResult> {
	void params.clarify;
	discoverAvailableSkills(params.cwd ?? params.ctx.cwd); // keep discovery side effects/cache behavior from upstream minimal path
	const chainSkills = params.chainSkills ?? [];
	const availableModels: ModelInfo[] = params.ctx.modelRegistry.getAvailable().map(toModelInfo);
	const chainAgents = params.chain.map((step) => isParallelStep(step) ? `[${step.parallel.map((task) => task.agent).join("+")}]` : step.agent);
	const state: ChainRunState = {
		results: [],
		allProgress: [],
		allArtifactPaths: [],
		chainAgents,
		totalSteps: params.chain.length,
		artifactsDir: params.artifactsDir,
		includeProgress: params.includeProgress,
	};
	const firstStep = params.chain[0];
	if (!firstStep) return errorResult("Chain must contain at least one step", state);
	const originalTask = params.task ?? (isParallelStep(firstStep) ? firstStep.parallel[0]?.task : firstStep.task) ?? "";
	let previous = "";
	let globalIndex = 0;

	for (let stepIndex = 0; stepIndex < params.chain.length; stepIndex++) {
		const step = params.chain[stepIndex]!;
		if (isParallelStep(step)) {
			const expandedTasks = step.parallel.flatMap((task) => Array.from({ length: task.count ?? 1 }, () => task));
			const agentConfigs = expandedTasks.map((task) => findAgent(params.agents, task.agent));
			const missing = expandedTasks.find((task, index) => !agentConfigs[index]);
			if (missing) return errorResult(`Unknown agent: ${missing.agent}`, state, stepIndex);
			const behaviors = resolveParallelBehaviors(expandedTasks, agentConfigs as AgentConfig[], chainSkills);
			let aborted = false;
			const startIndex = globalIndex;
			const parallelResults = await mapConcurrent(expandedTasks, step.concurrency ?? MAX_CONCURRENCY, async (task, taskIndex) => {
				if (aborted && step.failFast) {
					return {
						agent: task.agent,
						task: "(skipped)",
						exitCode: -1,
						messages: [],
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
						error: "Skipped due to fail-fast",
					} as SingleResult;
				}
				const template = task.task ?? "{previous}";
				const rendered = renderChainTaskTemplate(template, originalTask, previous);
				const result = await runChainChild({
					params,
					state,
					agentName: task.agent,
					task: rendered,
					stepCwd: task.cwd,
					behavior: behaviors[taskIndex]!,
					availableModels,
					globalIndex: startIndex + taskIndex,
				});
				if (result.exitCode !== 0 && step.failFast) aborted = true;
				return result;
			});
			for (const result of parallelResults) collectResultArtifacts(state, result);
			previous = parallelResults.map((result) => getSingleResultOutput(result).trim() || result.error || "").join("\n\n---\n\n");
			globalIndex += expandedTasks.length;
		} else {
			const agent = findAgent(params.agents, step.agent);
			if (!agent) return errorResult(`Unknown agent: ${step.agent}`, state, stepIndex);
			const behavior = resolveStepBehavior(agent, {
				output: step.output,
				outputMode: step.outputMode,
				reads: step.reads,
				progress: false,
				skills: normalizeSkillInput(step.skill),
				model: step.model,
				thinking: step.thinking,
			}, chainSkills);
			const template = step.task ?? (stepIndex === 0 ? originalTask : "{previous}");
			const rendered = renderChainTaskTemplate(template, originalTask, previous);
			const result = await runChainChild({
				params,
				state,
				agentName: step.agent,
				task: rendered,
				stepCwd: step.cwd,
				behavior: { ...behavior, progress: false },
				availableModels,
				globalIndex,
			});
			collectResultArtifacts(state, result);
			previous = getSingleResultOutput(result).trim() || result.error || "";
			globalIndex++;
		}

		params.onUpdate?.({
			content: [{ type: "text", text: `Completed chain step ${stepIndex + 1}/${params.chain.length}` }],
			details: buildDetails(state, stepIndex),
		});

		if (state.results.some((result) => result.exitCode !== 0)) {
			return errorResult(`Chain failed at step ${stepIndex + 1}\n\n${summarizeResults(state.results)}`, state, stepIndex);
		}
	}

	const summary = `Chain completed (${params.chain.length} steps)\n\n${summarizeResults(state.results)}`;
	return {
		content: [{ type: "text", text: summary }],
		details: buildDetails(state),
	};
}
