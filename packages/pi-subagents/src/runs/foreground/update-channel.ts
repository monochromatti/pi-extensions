// Progress updates are best-effort UI events, not part of the durable
// subagent result contract. Parent agent listeners can become invalid before
// child processes finish, especially for async/detached runs. Update channels
// make that lifecycle explicit: closed channels drop updates, and callback
// failures close the channel instead of crashing execution.

export type UpdateErrorPolicy = "drop" | "throw";

export interface UpdateChannel<T> {
	emit(value: T): boolean;
	close(): void;
	isClosed(): boolean;
}

export function isStaleAgentListenerError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("Agent listener invoked outside active run");
}

export function createUpdateChannel<T>(
	onUpdate: ((value: T) => void) | undefined,
	options: {
		onError?: (error: unknown) => void;
		errorPolicy?: UpdateErrorPolicy;
	} = {},
): UpdateChannel<T> {
	let closed = !onUpdate;

	const close = () => {
		closed = true;
	};

	return {
		emit(value: T): boolean {
			if (closed || !onUpdate) return false;

			try {
				onUpdate(value);
				return true;
			} catch (error) {
				close();
				if (options.errorPolicy === "throw") throw error;
				options.onError?.(error);
				return false;
			}
		},

		close,

		isClosed(): boolean {
			return closed;
		},
	};
}
