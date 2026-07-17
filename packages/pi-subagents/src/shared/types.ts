/**
 * Type definitions for the subagent extension
 */

import type { Message } from "@earendil-works/pi-ai";
import type { FSWatcher } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MaxOutputConfig, SavedOutputReference, TruncationResult } from "./output.ts";

// ============================================================================
// Basic Types
// ============================================================================

export type { MaxOutputConfig, SavedOutputReference, TruncationResult } from "./output.ts";

export type OutputMode = "inline" | "file-only";

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface TokenUsage {
	input: number;
	output: number;
	total: number;
}

export type ActivityState = "active_long_running" | "needs_attention";
export type ControlEventType = "active_long_running" | "needs_attention";
export type ControlNotificationChannel = "event" | "async" | "intercom";

export interface ControlConfig {
	enabled?: boolean;
	needsAttentionAfterMs?: number;
	activeNoticeAfterMs?: number;
	activeNoticeAfterTurns?: number;
	activeNoticeAfterTokens?: number;
	failedToolAttemptsBeforeAttention?: number;
	notifyOn?: ControlEventType[];
	notifyChannels?: ControlNotificationChannel[];
}

export interface ResolvedControlConfig {
	enabled: boolean;
	needsAttentionAfterMs: number;
	activeNoticeAfterMs: number;
	activeNoticeAfterTurns?: number;
	activeNoticeAfterTokens?: number;
	failedToolAttemptsBeforeAttention: number;
	notifyOn: ControlEventType[];
	notifyChannels: ControlNotificationChannel[];
}

export interface ControlEvent {
	type: ControlEventType;
	from?: ActivityState;
	to: ActivityState;
	ts: number;
	agent: string;
	index?: number;
	runId: string;
	message: string;
	reason?: "idle" | "completion_guard" | "active_long_running" | "tool_failures" | "time_threshold" | "turn_threshold" | "token_threshold";
	turns?: number;
	tokens?: number;
	toolCount?: number;
	currentTool?: string;
	currentToolDurationMs?: number;
	currentPath?: string;
	elapsedMs?: number;
	recentFailureSummary?: string;
}

export interface SupervisorIntercomTarget {
	piSessionId: string;
	intercomSessionId: string;
	alias: string;
	cwd: string;
}

export type SubagentResultStatus = "completed" | "failed" | "paused" | "detached" | "blocked_capability" | "blocked_decision";
export type SubagentRunMode = "single" | "parallel" | "chain";

export interface SubagentResultIntercomChild {
	agent: string;
	status: SubagentResultStatus;
	summary: string;
	index?: number;
	artifactPath?: string;
	sessionPath?: string;
	intercomTarget?: string;
}

export interface IntercomRelayTarget {
	intercomSessionId?: string;
	piSessionId?: string;
	alias?: string;
	namespace?: string;
}

export interface SubagentResultIntercomPayload {
	ownerPiSessionId: string;
	target: IntercomRelayTarget;
	to?: string;
	message: string;
	requestId?: string;
	runId: string;
	mode: SubagentRunMode;
	status: SubagentResultStatus;
	summary: string;
	source: "foreground" | "async";
	children: SubagentResultIntercomChild[];
	asyncId?: string;
	asyncDir?: string;
	chainSteps?: number;
	agent?: string;
	index?: number;
	artifactPath?: string;
	sessionPath?: string;
}

// ============================================================================
// Progress Tracking
// ============================================================================

export interface AgentProgress {
	index: number;
	agent: string;
	status: "pending" | "running" | "completed" | "failed" | "detached" | "blocked_capability" | "blocked_decision";
	activityState?: ActivityState;
	task: string;
	skills?: string[];
	lastActivityAt?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	recentTools: Array<{ tool: string; args: string; endMs: number }>;
	recentOutput: string[];
	toolCount: number;
	turnCount?: number;
	tokens: number;
	durationMs: number;
	error?: string;
	failedTool?: string;
}

export interface ToolCallSummary {
	text: string;
	expandedText: string;
}

interface ProgressSummary {
	toolCount: number;
	tokens: number;
	durationMs: number;
}

// ============================================================================
// Results
// ============================================================================

export interface ModelAttempt {
	model: string;
	success: boolean;
	exitCode?: number | null;
	error?: string;
	usage?: Usage;
}

export interface SingleResult {
	agent: string;
	task: string;
	exitCode: number;
	terminalStatus?: SubagentResultStatus;
	detached?: boolean;
	detachedReason?: string;
	interrupted?: boolean;
	messages?: Message[];
	usage: Usage;
	model?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	controlEvents?: ControlEvent[];
	error?: string;
	sessionFile?: string;
	skills?: string[];
	skillsWarning?: string;
	progress?: AgentProgress;
	progressSummary?: ProgressSummary;
	toolCalls?: ToolCallSummary[];
	artifactPaths?: ArtifactPaths;
	truncation?: TruncationResult;
	finalOutput?: string;
	outputMode?: OutputMode;
	savedOutputPath?: string;
	outputReference?: SavedOutputReference;
	outputSaveError?: string;
}

export interface Details {
	mode: SubagentRunMode | "management";
	runId?: string;
	context?: "fresh" | "fork";
	results: SingleResult[];
	controlEvents?: ControlEvent[];
	asyncId?: string;
	asyncDir?: string;
	progress?: AgentProgress[];
	progressSummary?: ProgressSummary;
	artifacts?: {
		dir: string;
		files: ArtifactPaths[];
	};
	truncation?: {
		truncated: boolean;
		originalBytes?: number;
		originalLines?: number;
		artifactPath?: string;
	};
	// Chain metadata for observability
	chainAgents?: string[];      // Agent names in order, e.g., ["scout", "planner"]
	totalSteps?: number;         // Total steps in chain
	currentStepIndex?: number;   // 0-indexed current step (for running chains)
}

// ============================================================================
// Artifacts
// ============================================================================

export interface ArtifactPaths {
	inputPath: string;
	outputPath: string;
	jsonlPath: string;
	metadataPath: string;
}

export interface ArtifactConfig {
	enabled: boolean;
	includeInput: boolean;
	includeOutput: boolean;
	includeJsonl: boolean;
	includeMetadata: boolean;
	cleanupDays: number;
}

// ============================================================================
// Async Execution
// ============================================================================

export interface AsyncParallelGroupStatus {
	start: number;
	count: number;
	stepIndex: number;
}

export interface AsyncStartedEvent {
	id?: string;
	asyncDir?: string;
	pid?: number;
	sessionId?: string;
	mode?: SubagentRunMode;
	agent?: string;
	agents?: string[];
	chain?: string[];
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
}

export interface AsyncStatus {
	runId: string;
	sessionId?: string;
	mode: SubagentRunMode;
	state: "queued" | "running" | "waiting_decision" | "complete" | "failed" | "paused";
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	startedAt: number;
	endedAt?: number;
	lastUpdate?: number;
	pid?: number;
	cwd?: string;
	currentStep?: number;
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	steps?: Array<{
		agent: string;
		status: "pending" | "running" | "waiting_decision" | "complete" | "completed" | "failed" | "paused";
		sessionFile?: string;
		activityState?: ActivityState;
		lastActivityAt?: number;
		currentTool?: string;
		currentToolArgs?: string;
		currentToolStartedAt?: number;
		currentPath?: string;
		recentTools?: Array<{ tool: string; args: string; endMs: number }>;
		recentOutput?: string[];
		turnCount?: number;
		toolCount?: number;
		startedAt?: number;
		endedAt?: number;
		durationMs?: number;
		exitCode?: number | null;
		tokens?: TokenUsage;
		skills?: string[];
		model?: string;
		attemptedModels?: string[];
		modelAttempts?: ModelAttempt[];
		error?: string;
	}>;
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	sessionFile?: string;
}

export type AsyncJobStep = NonNullable<AsyncStatus["steps"]>[number] & {
	index?: number;
};

export interface AsyncJobState {
	asyncId: string;
	asyncDir: string;
	status: "queued" | "running" | "waiting_decision" | "complete" | "failed" | "paused";
	pid?: number;
	sessionId?: string;
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	mode?: SubagentRunMode;
	agents?: string[];
	currentStep?: number;
	chainStepCount?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	steps?: AsyncJobStep[];
	stepsTotal?: number;
	runningSteps?: number;
	completedSteps?: number;
	hasParallelGroups?: boolean;
	activeParallelGroup?: boolean;
	startedAt?: number;
	updatedAt?: number;
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	sessionFile?: string;
	controlEventCursor?: number;
}

export interface ForegroundResumeChild {
	agent: string;
	index: number;
	sessionFile?: string;
	artifactPath?: string;
	finalOutput?: string;
	error?: string;
	status: SubagentResultStatus;
}

export interface ForegroundResumeRun {
	runId: string;
	mode: SubagentRunMode;
	cwd: string;
	updatedAt: number;
	children: ForegroundResumeChild[];
}

export interface SubagentState {
	baseCwd: string;
	currentSessionId: string | null;
	asyncJobs: Map<string, AsyncJobState>;
	foregroundRuns?: Map<string, ForegroundResumeRun>;
	foregroundControls: Map<string, {
		runId: string;
		mode: SubagentRunMode;
		startedAt: number;
		updatedAt: number;
		currentAgent?: string;
		currentIndex?: number;
		currentActivityState?: ActivityState;
		lastActivityAt?: number;
		currentTool?: string;
		currentToolStartedAt?: number;
		currentPath?: string;
		turnCount?: number;
		tokens?: number;
		toolCount?: number;
		interrupt?: () => boolean;
	}>;
	lastForegroundControlId: string | null;
	pendingForegroundControlNotices?: Map<string, ReturnType<typeof setTimeout>>;
	cleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
	lastUiContext: ExtensionContext | null;
	poller: NodeJS.Timeout | null;
	completionSeen: Map<string, number>;
	watcher: FSWatcher | null;
	watcherRestartTimer: ReturnType<typeof setTimeout> | null;
	resultFileCoalescer: {
		schedule(file: string, delayMs?: number): boolean;
		clear(): void;
	};
}

// ============================================================================
// Display
// ============================================================================

export type DisplayItem = 
	| { type: "text"; text: string } 
	| { type: "tool"; name: string; args: Record<string, unknown> };

// ============================================================================
// Error Handling
// ============================================================================

export interface ErrorInfo {
	hasError: boolean;
	exitCode?: number;
	errorType?: string;
	details?: string;
}

export interface IntercomEventBus {
	on(channel: string, handler: (data: unknown) => void): () => void;
	emit(channel: string, data: unknown): void;
}

export const INTERCOM_DETACH_REQUEST_EVENT = "pi-intercom:detach-request";
export const INTERCOM_DETACH_RESPONSE_EVENT = "pi-intercom:detach-response";
export const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
export const SUBAGENT_CONTROL_EVENT = "subagent:control-event";
export const SUBAGENT_CONTROL_INTERCOM_EVENT = "subagent:control-intercom";
export const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";
export const SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT = "subagent:result-intercom-delivery";

// ============================================================================
// Execution Options
// ============================================================================

export interface RunSyncOptions {
	cwd?: string;
	signal?: AbortSignal;
	interruptSignal?: AbortSignal;
	allowIntercomDetach?: boolean;
	intercomEvents?: IntercomEventBus;
	onUpdate?: (r: import("@earendil-works/pi-agent-core").AgentToolResult<Details>) => void;
	onControlEvent?: (event: ControlEvent) => void;
	controlConfig?: ResolvedControlConfig;
	intercomSessionName?: string;
	orchestratorIntercomTarget?: string;
	orchestratorIntercomCwd?: string;
	supervisorIntercomTarget?: SupervisorIntercomTarget;
	supervisorWaitMode?: "foreground" | "async";
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig?: ArtifactConfig;
	runId: string;
	index?: number;
	sessionDir?: string;
	sessionFile?: string;
	share?: boolean;
	outputPath?: string;
	outputMode?: OutputMode;
	maxSubagentDepth?: number;
	/** Override the agent's default model (format: "provider/id" or just "id") */
	modelOverride?: string;
	/** Override the agent's default thinking level (off|minimal|low|medium|high|xhigh) */
	thinkingOverride?: string;
	/** Registry models available for heuristic bare-model resolution */
	availableModels?: Array<{ provider: string; id: string; fullId: string }>;
	/** Current parent-session provider to prefer for ambiguous bare model ids */
	preferredModelProvider?: string;
	/** Skills to inject (overrides agent default if provided) */
	skills?: string[];
}

export type IntercomBridgeMode = "off" | "fork-only" | "always";

export interface IntercomBridgeConfig {
	mode?: IntercomBridgeMode;
	instructionFile?: string;
}

interface TopLevelParallelConfig {
	maxTasks?: number;
	concurrency?: number;
}

export interface ExtensionConfig {
	asyncByDefault?: boolean;
	forceTopLevelAsync?: boolean;
	defaultSessionDir?: string;
	maxSubagentDepth?: number;
	control?: ControlConfig;
	parallel?: TopLevelParallelConfig;
	intercomBridge?: IntercomBridgeConfig;
}

// ============================================================================
// Constants
// ============================================================================

export { DEFAULT_MAX_OUTPUT, truncateOutput } from "./output.ts";

export const DEFAULT_ARTIFACT_CONFIG: ArtifactConfig = {
	enabled: true,
	includeInput: true,
	includeOutput: true,
	includeJsonl: false,
	includeMetadata: true,
	cleanupDays: 7,
};

const MAX_PARALLEL = 8;
export const MAX_CONCURRENCY = 4;
export {
	resolveTempScopeId,
	TEMP_ROOT_DIR,
	RESULTS_DIR,
	ASYNC_DIR,
	CHAIN_RUNS_DIR,
	TEMP_ARTIFACTS_DIR,
	getAsyncConfigPath,
} from "./temp-paths.ts";
export const WIDGET_KEY = "subagent-async";
export const SLASH_RESULT_TYPE = "subagent-slash-result";
export const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
export const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
export const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";
export const SLASH_SUBAGENT_UPDATE_EVENT = "subagent:slash:update";
export const SLASH_SUBAGENT_CANCEL_EVENT = "subagent:slash:cancel";
export const POLL_INTERVAL_MS = 250;
export const MAX_WIDGET_JOBS = 4;
export { DEFAULT_SUBAGENT_MAX_DEPTH } from "./depth.ts";
export const SUBAGENT_CONTROL_ACTIONS = ["status", "interrupt", "resume", "collect"] as const;

export const DEFAULT_FORK_PREAMBLE =
	"You are a delegated subagent running from a fork of the parent session. " +
	"Treat the inherited conversation as reference-only context, not a live thread to continue. " +
	"Do not continue or answer prior messages as if they are waiting for a reply. " +
	"Your sole job is to execute the task below and return a focused result for that task using your tools.";

function normalizeTopLevelParallelValue(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isInteger(parsed) || parsed < 1) return undefined;
	return parsed;
}

export function resolveTopLevelParallelMaxTasks(value: unknown): number {
	return normalizeTopLevelParallelValue(value) ?? MAX_PARALLEL;
}

export function resolveTopLevelParallelConcurrency(
	override: unknown,
	configValue: unknown,
): number {
	return normalizeTopLevelParallelValue(override)
		?? normalizeTopLevelParallelValue(configValue)
		?? MAX_CONCURRENCY;
}

export function wrapForkTask(task: string, preamble?: string | false): string {
	if (preamble === false) return task;
	const effectivePreamble = preamble ?? DEFAULT_FORK_PREAMBLE;
	const wrappedPrefix = `${effectivePreamble}\n\nTask:\n`;
	if (task.startsWith(wrappedPrefix)) return task;
	return `${wrappedPrefix}${task}`;
}

// ============================================================================
// Recursion Depth Guard
// ============================================================================

export {
	normalizeMaxSubagentDepth,
	resolveCurrentMaxSubagentDepth,
	resolveChildMaxSubagentDepth,
	checkSubagentDepth,
	getSubagentDepthEnv,
} from "./depth.ts";
