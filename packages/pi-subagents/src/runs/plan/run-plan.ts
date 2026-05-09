import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { AgentConfig } from "../../agents/agents.ts";
import { normalizeSkillInput } from "../../agents/skills.ts";
import { resolveModelCandidate, type AvailableModelInfo } from "../shared/model-fallback.ts";
import { resolveControlConfig } from "../shared/subagent-control.ts";
import { getArtifactsDir } from "../../shared/artifacts.ts";
import {
	isParallelStep,
	resolveStepBehavior,
	suppressProgressForReadOnlyTask,
	type ChainStep,
	type ResolvedStepBehavior,
	type StepOverrides,
} from "../../shared/settings.ts";
import {
	DEFAULT_ARTIFACT_CONFIG,
	resolveChildMaxSubagentDepth,
	resolveCurrentMaxSubagentDepth,
	resolveTopLevelParallelConcurrency,
	resolveTopLevelParallelMaxTasks,
	type ArtifactConfig,
	type ExtensionConfig,
	type ResolvedControlConfig,
	type SubagentRunMode,
	wrapForkTask,
} from "../../shared/types.ts";
import type { SubagentParamsLike, TaskParam } from "../foreground/subagent-request-types.ts";

export interface BuildRunPlanInput {
	mode: SubagentRunMode;
	params: SubagentParamsLike;
	effectiveCwd: string;
	agents: AgentConfig[];
	config: ExtensionConfig;
	asyncByDefault: boolean;
	asyncAvailable: boolean;
	parentSessionFile: string | null;
	tempArtifactsDir: string;
	getSubagentSessionRoot: (parentSessionFile: string | null) => string;
	expandTilde: (p: string) => string;
	sessionFileFromContext?: (idx?: number) => string | undefined;
	runId?: string;
	action?: string;
	availableModels?: AvailableModelInfo[];
	currentModelProvider?: string;
}

export interface RunPlanAsyncMode {
	requestedAsync: boolean;
	effectiveAsync: boolean;
	asyncLaunchAllowed: boolean;
	reason: "explicit" | "config_default" | "management_action";
}

interface RunPlanSessionPaths {
	root: string;
	dirForIndex: (idx?: number) => string;
	fileForIndex: (idx?: number) => string;
}

interface RunPlanDepth {
	current: number;
	forAgent: (agent: AgentConfig) => number;
}

interface RunPlanBase {
	mode: SubagentRunMode;
	params: SubagentParamsLike;
	effectiveCwd: string;
	runId: string;
	session: RunPlanSessionPaths;
	artifactConfig: ArtifactConfig;
	artifactsDir: string;
	controlConfig: ResolvedControlConfig;
	depth: RunPlanDepth;
	asyncMode: RunPlanAsyncMode;
	agentsByName: Map<string, AgentConfig>;
}

export interface SingleRunPlan extends RunPlanBase {
	mode: "single";
	agent: AgentConfig;
	task: string;
	output: string | false | undefined;
	outputMode: "inline" | "file-only";
	skills: string[];
	model: string | undefined;
	thinking: string | undefined;
	maxSubagentDepth: number;
	sessionFile: string;
}

export interface ParallelChildPlan {
	index: number;
	task: TaskParam;
	agent: AgentConfig;
	behavior: ResolvedStepBehavior;
	sessionFile: string;
	model: string | undefined;
	maxSubagentDepth: number;
}

export interface ParallelRunPlan extends RunPlanBase {
	mode: "parallel";
	tasks: TaskParam[];
	maxTasks: number;
	concurrency: number;
	children: ParallelChildPlan[];
}

export interface ChainSequentialStepPlan {
	type: "sequential";
	index: number;
	agent: AgentConfig;
	taskTemplate: string;
	behavior: ResolvedStepBehavior;
}

export interface ChainParallelTaskPlan {
	index: number;
	agent: AgentConfig;
	taskTemplate: string;
	behavior: ResolvedStepBehavior;
}

export interface ChainParallelStepPlan {
	type: "parallel";
	index: number;
	concurrency: number;
	tasks: ChainParallelTaskPlan[];
}

export type ChainStepPlan = ChainSequentialStepPlan | ChainParallelStepPlan;

export interface ChainRunPlan extends RunPlanBase {
	mode: "chain";
	chainSkills: string[];
	steps: ChainStepPlan[];
}

export type RunPlan = SingleRunPlan | ParallelRunPlan | ChainRunPlan;

function resolveAsyncMode(input: BuildRunPlanInput): RunPlanAsyncMode {
	const isManagementAction = input.action === "status" || input.action === "interrupt" || input.action === "resume";
	if (isManagementAction) {
		return {
			requestedAsync: false,
			effectiveAsync: false,
			asyncLaunchAllowed: false,
			reason: "management_action",
		};
	}
	const requestedAsync = input.params.async ?? input.asyncByDefault;
	return {
		requestedAsync,
		effectiveAsync: requestedAsync,
		asyncLaunchAllowed: requestedAsync && input.asyncAvailable,
		reason: input.params.async !== undefined ? "explicit" : "config_default",
	};
}

function expandTopLevelTasks(tasks: TaskParam[] | undefined): TaskParam[] {
	if (!tasks) return [];
	const expanded: TaskParam[] = [];
	for (const task of tasks) {
		const repeat = Number.isInteger(task.count) && task.count! > 0 ? task.count! : 1;
		const { count, ...rest } = task;
		for (let i = 0; i < repeat; i++) expanded.push({ ...rest });
	}
	return expanded;
}

function expandChainCounts(chain: ChainStep[] | undefined): ChainStep[] {
	if (!chain) return [];
	return chain.map((step) => {
		if (!isParallelStep(step)) return step;
		const parallel: typeof step.parallel = [];
		for (const task of step.parallel) {
			const repeat = Number.isInteger(task.count) && task.count! > 0 ? task.count! : 1;
			const { count, ...rest } = task;
			for (let i = 0; i < repeat; i++) parallel.push({ ...rest });
		}
		return { ...step, parallel };
	});
}

function resolveSessionPaths(input: BuildRunPlanInput, runId: string): RunPlanSessionPaths {
	const sessionRoot = input.params.sessionDir
		? path.resolve(input.expandTilde(input.params.sessionDir))
		: path.join(
			input.config.defaultSessionDir
				? path.resolve(input.expandTilde(input.config.defaultSessionDir))
				: input.getSubagentSessionRoot(input.parentSessionFile),
			runId,
		);
	const fromContext = input.sessionFileFromContext ?? (() => undefined);
	const dirForIndex = (idx?: number) => path.join(sessionRoot, `run-${idx ?? 0}`);
	const fileForIndex = (idx?: number) => fromContext(idx) ?? path.join(dirForIndex(idx), "session.jsonl");
	return { root: sessionRoot, dirForIndex, fileForIndex };
}

function makeBasePlan(input: BuildRunPlanInput): RunPlanBase {
	const runId = input.runId ?? randomUUID().slice(0, 8);
	const asyncMode = resolveAsyncMode(input);
	const session = resolveSessionPaths(input, runId);
	const artifactConfig: ArtifactConfig = { ...DEFAULT_ARTIFACT_CONFIG };
	const artifactsDir = asyncMode.effectiveAsync ? input.tempArtifactsDir : getArtifactsDir(input.parentSessionFile);
	const controlConfig = resolveControlConfig(input.config.control, input.params.control);
	const currentDepth = resolveCurrentMaxSubagentDepth(input.config.maxSubagentDepth);
	const depth: RunPlanDepth = {
		current: currentDepth,
		forAgent: (agent) => resolveChildMaxSubagentDepth(currentDepth, agent.maxSubagentDepth),
	};
	const agentsByName = new Map(input.agents.map((agent) => [agent.name, agent]));
	return {
		mode: input.mode,
		params: input.params,
		effectiveCwd: input.effectiveCwd,
		runId,
		session,
		artifactConfig,
		artifactsDir,
		controlConfig,
		depth,
		asyncMode,
		agentsByName,
	};
}

function resolveModel(
	requested: string | undefined,
	agent: AgentConfig,
	input: BuildRunPlanInput,
): string | undefined {
	if (!input.availableModels) return requested ?? agent.model;
	return resolveModelCandidate(requested ?? agent.model, input.availableModels, input.currentModelProvider);
}

function resolveParallelBehavior(task: TaskParam, agent: AgentConfig): StepOverrides {
	return {
		...(task.output !== undefined ? { output: task.output === true ? agent.output ?? false : task.output } : {}),
		...(task.outputMode !== undefined ? { outputMode: task.outputMode } : {}),
		...(task.reads !== undefined && task.reads !== true ? { reads: task.reads } : {}),
		...(task.progress !== undefined ? { progress: task.progress } : {}),
		...(task.skill !== undefined ? { skills: normalizeSkillInput(task.skill) } : {}),
		...(task.model ? { model: task.model } : {}),
		...(task.thinking ? { thinking: task.thinking } : {}),
	};
}

function resolveChainTaskTemplate(rawTask: string | undefined, fallbackTask: string | undefined): string {
	return rawTask ?? fallbackTask ?? "{previous}";
}

export function buildRunPlan(input: BuildRunPlanInput): RunPlan {
	const base = makeBasePlan(input);

	if (input.mode === "single") {
		const agent = base.agentsByName.get(input.params.agent ?? "");
		if (!agent) throw new Error(`Unknown agent: ${input.params.agent}`);
		const rawOutput = input.params.output !== undefined ? input.params.output : agent.output;
		const output = rawOutput === true ? agent.output : (rawOutput as string | false | undefined);
		const rawSkills = normalizeSkillInput(input.params.skill);
		const skills = rawSkills === false ? [] : rawSkills ?? [];
		return {
			...base,
			mode: "single",
			agent,
			task: input.params.context === "fork" ? wrapForkTask(input.params.task ?? "") : (input.params.task ?? ""),
			output,
			outputMode: input.params.outputMode ?? "inline",
			skills,
			model: resolveModel(input.params.model, agent, input),
			thinking: input.params.thinking ?? agent.thinking,
			maxSubagentDepth: base.depth.forAgent(agent),
			sessionFile: base.session.fileForIndex(0),
		};
	}

	if (input.mode === "parallel") {
		const tasks = expandTopLevelTasks(input.params.tasks);
		const maxTasks = resolveTopLevelParallelMaxTasks(input.config.parallel?.maxTasks);
		const concurrencyRequested = resolveTopLevelParallelConcurrency(input.params.concurrency, input.config.parallel?.concurrency);
		const concurrency = Math.min(concurrencyRequested, Math.max(1, tasks.length || 1));
		const children = tasks.map((task, index) => {
			const agent = base.agentsByName.get(task.agent);
			if (!agent) throw new Error(`Unknown agent: ${task.agent}`);
			const behavior = suppressProgressForReadOnlyTask(resolveStepBehavior(agent, resolveParallelBehavior(task, agent)), task.task);
			return {
				index,
				task,
				agent,
				behavior,
				sessionFile: base.session.fileForIndex(index),
				model: resolveModel(task.model, agent, input),
				maxSubagentDepth: base.depth.forAgent(agent),
			};
		});
		return {
			...base,
			mode: "parallel",
			tasks,
			maxTasks,
			concurrency,
			children,
		};
	}

	const chain = expandChainCounts(input.params.chain);
	const normalizedChainSkills = normalizeSkillInput(input.params.skill);
	const chainSkills = normalizedChainSkills === false ? [] : normalizedChainSkills ?? [];
	const steps: ChainStepPlan[] = chain.map((step, stepIndex) => {
		if (isParallelStep(step)) {
			const concurrencyRequested = resolveTopLevelParallelConcurrency(step.concurrency, input.config.parallel?.concurrency);
			const concurrency = Math.min(concurrencyRequested, Math.max(1, step.parallel.length || 1));
			const tasks = step.parallel.map((task, taskIndex) => {
				const agent = base.agentsByName.get(task.agent);
				if (!agent) throw new Error(`Unknown agent: ${task.agent}`);
				const behavior = suppressProgressForReadOnlyTask(
					resolveStepBehavior(agent, {
						...(task.output !== undefined ? { output: task.output === true ? agent.output ?? false : task.output } : {}),
						...(task.outputMode !== undefined ? { outputMode: task.outputMode } : {}),
						...(task.reads !== undefined ? { reads: task.reads } : {}),
						...(task.progress !== undefined ? { progress: task.progress } : {}),
						...(task.skill !== undefined ? { skills: normalizeSkillInput(task.skill) } : {}),
						...(task.model ? { model: task.model } : {}),
						...(task.thinking ? { thinking: task.thinking } : {}),
					},
					chainSkills,
				),
				resolveChainTaskTemplate(task.task, stepIndex === 0 ? input.params.task : undefined),
			);
				return {
					index: taskIndex,
					agent,
					taskTemplate: resolveChainTaskTemplate(task.task, stepIndex === 0 ? input.params.task : undefined),
					behavior,
				};
			});
			return { type: "parallel", index: stepIndex, concurrency, tasks };
		}

		const agent = base.agentsByName.get(step.agent);
		if (!agent) throw new Error(`Unknown agent: ${step.agent}`);
		const taskTemplate = resolveChainTaskTemplate(step.task, stepIndex === 0 ? input.params.task : undefined);
		const behavior = suppressProgressForReadOnlyTask(resolveStepBehavior(agent, {
			...(step.output !== undefined ? { output: step.output === true ? agent.output ?? false : step.output } : {}),
			...(step.outputMode !== undefined ? { outputMode: step.outputMode } : {}),
			...(step.reads !== undefined ? { reads: step.reads } : {}),
			...(step.progress !== undefined ? { progress: step.progress } : {}),
			...(step.skill !== undefined ? { skills: normalizeSkillInput(step.skill) } : {}),
			...(step.model ? { model: step.model } : {}),
			...(step.thinking ? { thinking: step.thinking } : {}),
		}, chainSkills), taskTemplate);
		return {
			type: "sequential",
			index: stepIndex,
			agent,
			taskTemplate,
			behavior,
		};
	});

	return {
		...base,
		mode: "chain",
		chainSkills,
		steps,
	};
}
