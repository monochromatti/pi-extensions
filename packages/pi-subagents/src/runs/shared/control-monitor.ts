import type {
	ActivityState,
	ControlEvent,
	ResolvedControlConfig,
} from "../../shared/types.ts";
import {
	buildControlEvent,
	claimControlNotification,
	deriveActivityState,
} from "./subagent-control.ts";
import {
	createMutatingFailureState,
	didMutatingToolFail,
	nextLongRunningTrigger,
	recordMutatingFailure,
	resetMutatingFailureState,
	shouldEscalateMutatingFailures,
	summarizeRecentMutatingFailures,
} from "./long-running-guard.ts";

export interface CreateControlMonitorInput {
	config: ResolvedControlConfig;
	runId: string;
	agent: string;
	index?: number;
	startedAt: number;
	lastActivityAt?: number;
	childIntercomTarget?: string;
	mutatingFailureWindowMs?: number;
}

export interface ControlMonitorTickInput {
	now: number;
	turns: number;
	tokens: number;
	toolCount: number;
	currentTool?: string;
	currentToolDurationMs?: number;
	currentPath?: string;
	lastActivityAt?: number;
}

export interface MutatingToolResultInput {
	now: number;
	tool: string;
	path?: string;
	startedAt?: number;
	resultText: string;
	turns: number;
	tokens: number;
	toolCount: number;
}

export interface ControlMonitor {
	recordActivity(now: number): void;
	tick(input: ControlMonitorTickInput): ControlEvent | undefined;
	recordMutatingToolResult(input: MutatingToolResultInput): ControlEvent | undefined;
	resetMutatingFailures(): void;
	getActivityState(): ActivityState | undefined;
	getLastActivityAt(): number;
}

export function createControlMonitor(input: CreateControlMonitorInput): ControlMonitor {
	const seenNotificationKeys = new Set<string>();
	let activityState: ActivityState | undefined;
	let lastActivityAt = input.lastActivityAt ?? input.startedAt;
	let activeLongRunningNotified = false;
	const mutatingFailures = createMutatingFailureState();
	const mutatingFailureWindowMs = input.mutatingFailureWindowMs ?? 5 * 60_000;

	const maybeEmit = (event: ControlEvent): ControlEvent | undefined => {
		if (!claimControlNotification(input.config, event, seenNotificationKeys, input.childIntercomTarget)) return undefined;
		return event;
	};

	const buildNeedsAttentionEvent = (eventInput: {
		now: number;
		message?: string;
		reason?: ControlEvent["reason"];
		turns: number;
		tokens: number;
		toolCount: number;
		currentTool?: string;
		currentToolDurationMs?: number;
		currentPath?: string;
		recentFailureSummary?: string;
	}): ControlEvent | undefined => {
		const previous = activityState;
		activityState = "needs_attention";
		return maybeEmit(buildControlEvent({
			type: "needs_attention",
			from: previous,
			to: "needs_attention",
			runId: input.runId,
			agent: input.agent,
			index: input.index,
			ts: eventInput.now,
			lastActivityAt,
			message: eventInput.message,
			reason: eventInput.reason ?? "idle",
			turns: eventInput.turns,
			tokens: eventInput.tokens,
			toolCount: eventInput.toolCount,
			currentTool: eventInput.currentTool,
			currentToolDurationMs: eventInput.currentToolDurationMs,
			currentPath: eventInput.currentPath,
			recentFailureSummary: eventInput.recentFailureSummary,
		}));
	};

	return {
		recordActivity: (now: number) => {
			lastActivityAt = now;
		},
		tick: (tickInput: ControlMonitorTickInput): ControlEvent | undefined => {
			if (!input.config.enabled) return undefined;
			if (tickInput.lastActivityAt !== undefined) {
				lastActivityAt = tickInput.lastActivityAt;
			}
			const idleState = deriveActivityState({
				config: input.config,
				startedAt: input.startedAt,
				lastActivityAt,
				now: tickInput.now,
			});
			if (idleState === "needs_attention") {
				if (!tickInput.currentTool) {
					if (activityState === "needs_attention" || activeLongRunningNotified) return undefined;
					activeLongRunningNotified = true;
					const previous = activityState;
					activityState = "active_long_running";
					return maybeEmit(buildControlEvent({
						type: "active_long_running",
						from: previous,
						to: "active_long_running",
						runId: input.runId,
						agent: input.agent,
						index: input.index,
						ts: tickInput.now,
						lastActivityAt,
						message: `${input.agent} has had no model output for a while`,
						reason: "idle",
						turns: tickInput.turns,
						tokens: tickInput.tokens,
						toolCount: tickInput.toolCount,
						elapsedMs: tickInput.now - lastActivityAt,
					}));
				}
				return buildNeedsAttentionEvent({
					now: tickInput.now,
					turns: tickInput.turns,
					tokens: tickInput.tokens,
					toolCount: tickInput.toolCount,
					currentTool: tickInput.currentTool,
					currentToolDurationMs: tickInput.currentToolDurationMs,
					currentPath: tickInput.currentPath,
				});
			}
			if (activityState === "needs_attention" || activeLongRunningNotified) return undefined;
			const activeReason = nextLongRunningTrigger(input.config, {
				startedAt: input.startedAt,
				now: tickInput.now,
				turns: tickInput.turns,
				tokens: tickInput.tokens,
			});
			if (!activeReason) return undefined;
			activeLongRunningNotified = true;
			const previous = activityState;
			activityState = "active_long_running";
			return maybeEmit(buildControlEvent({
				type: "active_long_running",
				from: previous,
				to: "active_long_running",
				runId: input.runId,
				agent: input.agent,
				index: input.index,
				ts: tickInput.now,
				message: `${input.agent} is still active but long-running`,
				reason: activeReason,
				turns: tickInput.turns,
				tokens: tickInput.tokens,
				toolCount: tickInput.toolCount,
				currentTool: tickInput.currentTool,
				currentToolDurationMs: tickInput.currentToolDurationMs,
				currentPath: tickInput.currentPath,
				elapsedMs: tickInput.now - input.startedAt,
			}));
		},
		recordMutatingToolResult: (resultInput: MutatingToolResultInput): ControlEvent | undefined => {
			if (!didMutatingToolFail(resultInput.resultText)) {
				resetMutatingFailureState(mutatingFailures);
				return undefined;
			}
			recordMutatingFailure(mutatingFailures, {
				tool: resultInput.tool,
				path: resultInput.path,
				error: resultInput.resultText.split("\n").find((line) => line.trim())?.trim().slice(0, 180) ?? "mutating tool failed",
				ts: resultInput.now,
			}, mutatingFailureWindowMs);
			if (!shouldEscalateMutatingFailures(mutatingFailures, input.config.failedToolAttemptsBeforeAttention)) return undefined;
			return buildNeedsAttentionEvent({
				now: resultInput.now,
				message: `${input.agent} needs attention after repeated mutating tool failures`,
				reason: "tool_failures",
				turns: resultInput.turns,
				tokens: resultInput.tokens,
				toolCount: resultInput.toolCount,
				currentTool: resultInput.tool,
				currentToolDurationMs: resultInput.startedAt ? Math.max(0, resultInput.now - resultInput.startedAt) : undefined,
				currentPath: resultInput.path,
				recentFailureSummary: summarizeRecentMutatingFailures(mutatingFailures),
			});
		},
		resetMutatingFailures: () => {
			resetMutatingFailureState(mutatingFailures);
		},
		getActivityState: () => activityState,
		getLastActivityAt: () => lastActivityAt,
	};
}
