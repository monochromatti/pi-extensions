/**
 * Reduced TypeBox schema and validation helpers for minimal pi-subagents.
 */

import { Type } from "typebox";
import { SUBAGENT_CONTROL_ACTIONS } from "../shared/types.ts";

const REMOVED_FIELDS = ["chainDir", "worktree", "clarify", "config", "chainName", "agentScope", "artifacts"] as const;
const REMOVED_ACTIONS = ["list", "get", "create", "update", "delete", "doctor"] as const;

const SkillOverride = Type.Unsafe({
	anyOf: [
		{ type: "array", items: { type: "string" } },
		{ type: "boolean" },
		{ type: "string" },
	],
	description: "Skill name(s) to inject, array of strings, or boolean override",
});

const OutputOverride = Type.Unsafe({
	anyOf: [
		{ type: "string" },
		{ type: "boolean" },
	],
	description: "Output file path. Omit for inline result. Use true for agent default output path, or boolean false (not string \"false\") to disable file output.",
});

const OutputModeOverride = Type.String({
	enum: ["inline", "file-only"],
	description: "Return saved output inline or only a concise file reference. file-only requires output path.",
});

const ReadsOverride = Type.Unsafe({
	anyOf: [
		{ type: "array", items: { type: "string" } },
		{ type: "boolean" },
	],
	description: "Files to read before running, or false to disable reads",
});

const ContextOverride = Type.String({
	enum: ["fresh", "fork"],
	description: "fresh starts a clean child; fork branches from parent context",
});

const ControlOverrides = Type.Object({
	enabled: Type.Optional(Type.Boolean({ description: "Enable child attention tracking for this run" })),
	needsAttentionAfterMs: Type.Optional(Type.Integer({ minimum: 1, description: "Idle window before child needs attention" })),
	activeNoticeAfterMs: Type.Optional(Type.Integer({ minimum: 1, description: "Long-running notice threshold by elapsed ms" })),
	activeNoticeAfterTurns: Type.Optional(Type.Integer({ minimum: 1, description: "Long-running notice threshold by assistant turns" })),
	activeNoticeAfterTokens: Type.Optional(Type.Integer({ minimum: 1, description: "Long-running notice threshold by total tokens" })),
	failedToolAttemptsBeforeAttention: Type.Optional(Type.Integer({ minimum: 1, description: "Consecutive mutating-tool failures before attention" })),
	notifyOn: Type.Optional(Type.Array(Type.String({ enum: ["active_long_running", "needs_attention"] }), {
		description: "Control event types that notify parent/orchestrator",
	})),
	notifyChannels: Type.Optional(Type.Array(Type.String({ enum: ["event", "async", "intercom"] }), {
		description: "Notification channels to use when available",
	})),
});

const ParallelTaskSchema = Type.Object({
	agent: Type.String({ description: "Agent name" }),
	task: Type.String({ description: "Task text" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for this task" })),
	count: Type.Optional(Type.Integer({ minimum: 1, description: "Repeat this task N times" })),
	output: Type.Optional(OutputOverride),
	outputMode: Type.Optional(OutputModeOverride),
	reads: Type.Optional(ReadsOverride),
	skill: Type.Optional(SkillOverride),
	model: Type.Optional(Type.String({ description: "Model override for this task" })),
	thinking: Type.Optional(Type.String({ description: "Thinking override for this task" })),
});

const ChainParallelTaskSchema = Type.Object({
	agent: Type.String({ description: "Agent name" }),
	task: Type.Optional(Type.String({ description: "Task template using {task} and {previous}. Defaults to {previous}." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for this task" })),
	count: Type.Optional(Type.Integer({ minimum: 1, description: "Repeat this task N times" })),
	output: Type.Optional(OutputOverride),
	outputMode: Type.Optional(OutputModeOverride),
	reads: Type.Optional(ReadsOverride),
	skill: Type.Optional(SkillOverride),
	model: Type.Optional(Type.String({ description: "Model override for this task" })),
	thinking: Type.Optional(Type.String({ description: "Thinking override for this task" })),
});

const ChainStepSchema = Type.Object({
	agent: Type.Optional(Type.String({ description: "Sequential step agent name" })),
	task: Type.Optional(Type.String({ description: "Task template using {task} and {previous}; later steps default to {previous}." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for this step" })),
	output: Type.Optional(OutputOverride),
	outputMode: Type.Optional(OutputModeOverride),
	reads: Type.Optional(ReadsOverride),
	skill: Type.Optional(SkillOverride),
	model: Type.Optional(Type.String({ description: "Model override for this step" })),
	thinking: Type.Optional(Type.String({ description: "Thinking override for this step" })),
	parallel: Type.Optional(Type.Array(ChainParallelTaskSchema, { minItems: 1, description: "Tasks to run concurrently in this step" })),
	concurrency: Type.Optional(Type.Integer({ minimum: 1, description: "Max concurrent tasks for this step" })),
	failFast: Type.Optional(Type.Boolean({ description: "Stop this step on first task failure" })),
}, { description: "Chain step: use sequential agent fields or a parallel task array" });

export const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent name for single mode" })),
	task: Type.Optional(Type.String({ description: "Task text, or original request for chain templates" })),
	action: Type.Optional(Type.String({
		enum: [...SUBAGENT_CONTROL_ACTIONS],
		description: "Control action for async/background runs",
	})),
	id: Type.Optional(Type.String({ description: "Run id or prefix for status, interrupt, or resume" })),
	runId: Type.Optional(Type.String({ description: "Run id alias for interrupt or resume" })),
	dir: Type.Optional(Type.String({ description: "Async run directory for status or resume" })),
	index: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based child index for multi-child runs" })),
	message: Type.Optional(Type.String({ description: "Follow-up message for resume" })),
	tasks: Type.Optional(Type.Array(ParallelTaskSchema, { minItems: 1, description: "Parallel mode task list" })),
	concurrency: Type.Optional(Type.Integer({ minimum: 1, description: "Top-level parallel max concurrency" })),
	chain: Type.Optional(Type.Array(ChainStepSchema, { minItems: 1, description: "Chain mode sequential pipeline" })),
	context: Type.Optional(ContextOverride),
	async: Type.Optional(Type.Boolean({ description: "Run in background" })),
	cwd: Type.Optional(Type.String({ description: "Working directory" })),
	includeProgress: Type.Optional(Type.Boolean({ description: "Include detailed run progress in result" })),
	share: Type.Optional(Type.Boolean({ description: "Upload child session for sharing when supported" })),
	sessionDir: Type.Optional(Type.String({ description: "Directory to store child session logs" })),
	control: Type.Optional(ControlOverrides),
	output: Type.Optional(OutputOverride),
	outputMode: Type.Optional(OutputModeOverride),
	skill: Type.Optional(SkillOverride),
	model: Type.Optional(Type.String({ description: "Model override for single mode" })),
	thinking: Type.Optional(Type.String({ description: "Thinking override for single mode" })),
});

export interface SubagentValidationResult {
	ok: boolean;
	error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function containsRemovedTemplateVariable(value: unknown): boolean {
	if (typeof value === "string") return value.includes("{chain_dir}");
	if (Array.isArray(value)) return value.some(containsRemovedTemplateVariable);
	if (isRecord(value)) return Object.values(value).some(containsRemovedTemplateVariable);
	return false;
}

function findRemovedField(value: unknown): (typeof REMOVED_FIELDS)[number] | undefined {
	if (Array.isArray(value)) {
		for (const item of value) {
			const nested = findRemovedField(item);
			if (nested) return nested;
		}
		return undefined;
	}
	if (!isRecord(value)) return undefined;
	const direct = REMOVED_FIELDS.find((key) => hasOwn(value, key));
	if (direct) return direct;
	for (const nestedValue of Object.values(value)) {
		const nested = findRemovedField(nestedValue);
		if (nested) return nested;
	}
	return undefined;
}

function isStringFalse(value: unknown): boolean {
	return typeof value === "string" && value.trim().toLowerCase() === "false";
}

function validateOutputOptions(value: Record<string, unknown>, context: string): string | undefined {
	if (isStringFalse(value.output)) {
		return `${context} sets output as string "false". Use "output": false, not "output": "false".`;
	}
	if (value.outputMode === "file-only" && typeof value.output !== "string") {
		return `${context} sets outputMode: "file-only" but does not configure an output file. Set output to a path or use outputMode: "inline".`;
	}
	return undefined;
}

function validateCount(value: Record<string, unknown>, context: string): string | undefined {
	if (value.count !== undefined && (!Number.isInteger(value.count) || (value.count as number) < 1)) {
		return `${context} count must be an integer greater than or equal to 1`;
	}
	return undefined;
}

function validateConcurrency(value: Record<string, unknown>, context: string): string | undefined {
	if (value.concurrency !== undefined && (!Number.isInteger(value.concurrency) || (value.concurrency as number) < 1)) {
		return `${context} concurrency must be an integer greater than or equal to 1`;
	}
	return undefined;
}

function validateParallelTask(value: unknown, context: string, taskRequired: boolean): string | undefined {
	if (!isRecord(value)) return `${context} must be an object`;
	if (typeof value.agent !== "string" || value.agent.trim() === "") return `${context} agent must be a non-empty string`;
	if (taskRequired && (typeof value.task !== "string" || value.task.trim() === "")) return `${context} task must be a non-empty string`;
	return validateCount(value, context) ?? validateOutputOptions(value, context);
}

function validateChainStep(value: unknown, index: number): string | undefined {
	const context = `chain[${index}]`;
	if (!isRecord(value)) return `${context} must be an object`;
	const hasParallel = Array.isArray(value.parallel);
	const hasAgent = typeof value.agent === "string" && value.agent.trim() !== "";
	if (hasParallel && hasAgent) return `${context} must be either sequential or parallel, not both`;
	if (!hasParallel && !hasAgent) return `${context} must specify agent or parallel tasks`;
	if (hasParallel) {
		if (value.output !== undefined || value.outputMode !== undefined) return `${context} parallel step must set output options on each parallel task, not on the step container`;
		const tasks = value.parallel as unknown[];
		if (tasks.length === 0) return `${context}.parallel must contain at least one task`;
		const concurrencyError = validateConcurrency(value, context);
		if (concurrencyError) return concurrencyError;
		for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
			const error = validateParallelTask(tasks[taskIndex], `${context}.parallel[${taskIndex}]`, false);
			if (error) return error;
		}
		return undefined;
	}
	return validateOutputOptions(value, context);
}

export function validateSubagentParams(input: unknown): SubagentValidationResult {
	if (!isRecord(input)) return { ok: false, error: "subagent parameters must be an object" };

	const removedField = findRemovedField(input);
	if (removedField) {
		const messages: Record<(typeof REMOVED_FIELDS)[number], string> = {
			chainDir: "chainDir is not supported; use explicit output paths instead",
			worktree: "worktree mode is not supported by this pi-subagents package",
			clarify: "clarify TUI is not supported by this pi-subagents package",
			config: "agent management actions are not supported",
			chainName: "agent management actions are not supported",
			agentScope: "agentScope is not supported; project and user agents are discovered together",
			artifacts: "artifacts is not a public option; internal debug artifacts are managed automatically",
		};
		return { ok: false, error: messages[removedField] };
	}
	if (containsRemovedTemplateVariable(input)) {
		return { ok: false, error: "{chain_dir} template variable is not supported; use {previous} or explicit output files" };
	}

	if (typeof input.action === "string" && (REMOVED_ACTIONS as readonly string[]).includes(input.action)) {
		return { ok: false, error: "agent management actions are not supported" };
	}
	if (input.action !== undefined && !(SUBAGENT_CONTROL_ACTIONS as readonly string[]).includes(String(input.action))) {
		return { ok: false, error: "action must be one of: status, interrupt, resume" };
	}

	const modes = [
		input.action !== undefined,
		input.agent !== undefined,
		input.tasks !== undefined,
		input.chain !== undefined,
	].filter(Boolean).length;
	if (modes !== 1) return { ok: false, error: "Use exactly one subagent mode: agent, tasks, chain, or action" };

	const topConcurrencyError = validateConcurrency(input, "top-level");
	if (topConcurrencyError) return { ok: false, error: topConcurrencyError };
	const topOutputError = validateOutputOptions(input, "single run");
	if (topOutputError) return { ok: false, error: topOutputError };

	if (input.agent !== undefined && (typeof input.agent !== "string" || input.agent.trim() === "")) {
		return { ok: false, error: "agent must be a non-empty string" };
	}
	if (input.tasks !== undefined) {
		if (!Array.isArray(input.tasks) || input.tasks.length === 0) return { ok: false, error: "tasks must contain at least one task" };
		for (let index = 0; index < input.tasks.length; index++) {
			const error = validateParallelTask(input.tasks[index], `tasks[${index}]`, true);
			if (error) return { ok: false, error };
		}
	}
	if (input.chain !== undefined) {
		if (!Array.isArray(input.chain) || input.chain.length === 0) return { ok: false, error: "chain must contain at least one step" };
		for (let index = 0; index < input.chain.length; index++) {
			const error = validateChainStep(input.chain[index], index);
			if (error) return { ok: false, error };
		}
	}

	return { ok: true };
}

export function assertValidSubagentParams(input: unknown): void {
	const result = validateSubagentParams(input);
	if (!result.ok) throw new Error(result.error ?? "Invalid subagent parameters");
}
