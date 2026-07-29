import type { CanvasSessionState } from "./session.ts";

export type CanvasCheckpointEvent = {
	name: string;
	payload?: unknown;
	signals: Record<string, unknown>;
	timestamp: string;
};

export type CanvasAttentionEvent = {
	name: string;
	payload?: unknown;
	signals: Record<string, unknown>;
	timestamp: string;
	/**
	 * Set by the server, never by the posted body: "control" is a button the
	 * agent rendered, "selection-comment" is the built-in comment route. Agent
	 * HTML can forge a payload but cannot forge a source.
	 */
	source: "control" | "selection-comment";
};

export type WaitForEventResult = CanvasCheckpointEvent | { timeout: true };

export type AttentionCallback = (
	summary: string,
	options?: { deliverAs?: "steer" },
	event?: CanvasAttentionEvent,
) => void | Promise<void>;

export type AttentionPolicy = {
	isAgentActive?: () => boolean;
	onAttention?: AttentionCallback;
	formatSummary?: (event: CanvasAttentionEvent) => string;
};

export type CanvasEventWaiter = {
	name?: string;
	resolve: (result: WaitForEventResult) => void;
	timeoutHandle?: ReturnType<typeof setTimeout>;
	abortSignal?: AbortSignal;
	abortListener?: () => void;
};

export async function waitForEvent(
	session: CanvasSessionState,
	params?: { name?: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<WaitForEventResult> {
	const queuedIndex = findQueuedEventIndex(session.eventQueue, params?.name);
	if (queuedIndex >= 0) {
		const [event] = session.eventQueue.splice(queuedIndex, 1);
		return event;
	}

	const { promise, resolve } = Promise.withResolvers<WaitForEventResult>();

	const waiter: CanvasEventWaiter = {
		name: params?.name,
		resolve,
	};

	const finalize = (result: WaitForEventResult) => {
		cleanupWaiter(session, waiter);
		resolve(result);
	};

	waiter.resolve = finalize;
	session.waiters.push(waiter);

	if (typeof params?.timeoutMs === "number" && Number.isFinite(params.timeoutMs) && params.timeoutMs >= 0) {
		waiter.timeoutHandle = setTimeout(() => finalize({ timeout: true }), params.timeoutMs);
	}

	if (params?.signal) {
		waiter.abortSignal = params.signal;
		waiter.abortListener = () => finalize({ timeout: true });
		if (params.signal.aborted) {
			waiter.abortListener();
		} else {
			params.signal.addEventListener("abort", waiter.abortListener, { once: true });
		}
	}

	return promise;
}

export type CheckpointPushResult = {
	event: CanvasCheckpointEvent;
	/** True when a pending wait_for_event call consumed the event directly. */
	consumedByWaiter: boolean;
};

export function pushCheckpointEvent(
	session: CanvasSessionState,
	input: { name: string; payload?: unknown; timestamp?: string; signals?: Record<string, unknown> },
): CheckpointPushResult {
	const event: CanvasCheckpointEvent = {
		name: input.name,
		payload: input.payload,
		signals: input.signals ? { ...input.signals } : { ...session.signals },
		timestamp: input.timestamp ?? new Date().toISOString(),
	};

	const waiter = takeMatchingWaiter(session.waiters, event.name);
	if (waiter) {
		waiter.resolve(event);
		return { event, consumedByWaiter: true };
	}

	session.eventQueue.push(event);
	return { event, consumedByWaiter: false };
}

export async function pushAttentionEvent(
	session: CanvasSessionState,
	input: {
		name: string;
		payload?: unknown;
		timestamp?: string;
		signals?: Record<string, unknown>;
		source?: CanvasAttentionEvent["source"];
	},
	policy?: AttentionPolicy,
): Promise<CanvasAttentionEvent> {
	const event: CanvasAttentionEvent = {
		name: input.name,
		payload: input.payload,
		signals: input.signals ? { ...input.signals } : { ...session.signals },
		timestamp: input.timestamp ?? new Date().toISOString(),
		source: input.source ?? "control",
	};

	if (policy?.onAttention) {
		const summary = policy.formatSummary?.(event) ?? `Canvas attention event: ${event.name}`;
		const active = policy.isAgentActive?.() ?? false;
		await policy.onAttention(summary, active ? { deliverAs: "steer" } : undefined, event);
	}

	return event;
}

function findQueuedEventIndex(queue: CanvasCheckpointEvent[], name?: string): number {
	if (!name) return queue.length > 0 ? 0 : -1;
	return queue.findIndex((event) => event.name === name);
}

function takeMatchingWaiter(waiters: CanvasEventWaiter[], name: string): CanvasEventWaiter | undefined {
	const index = waiters.findIndex((waiter) => !waiter.name || waiter.name === name);
	if (index < 0) return undefined;
	const [waiter] = waiters.splice(index, 1);
	return waiter;
}

function cleanupWaiter(session: CanvasSessionState, waiter: CanvasEventWaiter): void {
	const index = session.waiters.indexOf(waiter);
	if (index >= 0) session.waiters.splice(index, 1);
	if (waiter.timeoutHandle) clearTimeout(waiter.timeoutHandle);
	if (waiter.abortSignal && waiter.abortListener) {
		waiter.abortSignal.removeEventListener("abort", waiter.abortListener);
	}
}
