import type { CanvasSessionState } from "./session.ts";

export function mergeQuietSignals(session: CanvasSessionState, incoming: Record<string, unknown>): void {
	session.signals = {
		...session.signals,
		...incoming,
	};
}

export function readSignals(session: CanvasSessionState, options?: { keys?: string[] }): Record<string, unknown> {
	if (!options?.keys || options.keys.length === 0) {
		return { ...session.signals };
	}

	const selected: Record<string, unknown> = {};
	for (const key of options.keys) {
		if (Object.hasOwn(session.signals, key)) {
			selected[key] = session.signals[key];
		}
	}
	return selected;
}
