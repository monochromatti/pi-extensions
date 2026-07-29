import { COMMENTS_SIGNAL_KEY } from "./comments.ts";
import type { CanvasSessionState } from "./session.ts";

// Server-owned keys: a browser snapshot must never rewrite them, or a late
// /sync from one tab would roll back comments recorded by another.
const RESERVED_SIGNAL_KEYS = new Set<string>([COMMENTS_SIGNAL_KEY]);

export function mergeQuietSignals(session: CanvasSessionState, incoming: Record<string, unknown>): void {
	const merged = { ...session.signals };
	for (const [key, value] of Object.entries(incoming)) {
		if (RESERVED_SIGNAL_KEYS.has(key)) continue;
		merged[key] = value;
	}
	session.signals = merged;
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
