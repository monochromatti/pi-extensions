import { sanitizeCanvasHtml } from "./security.ts";
import type { CanvasSessionState } from "./session.ts";

export type RenderMode = "inner" | "outer" | "append" | "prepend";

export type CanvasPatch = {
	id: number;
	selector: string;
	html: string;
	mode: RenderMode;
	timestamp: string;
};

export type CanvasRenderRuntime = {
	patches: CanvasPatch[];
	nextPatchId: number;
	rootRendered: boolean;
	subscribers: Set<(patch: CanvasPatch) => void>;
	declaredSlotNames: Set<string>;
};

export type RenderParams = {
	selector: string;
	html: string;
	mode?: RenderMode;
};

export type RenderResult =
	| {
			ok: true;
			patches: CanvasPatch[];
	  }
	| {
			ok: false;
			error: "selector_not_allowed" | "disallowed_remote_asset";
	  };

const BUILTIN_SELECTORS = new Set(["#root", "#status", "#sidebar"]);

export function createRenderRuntime(): CanvasRenderRuntime {
	return {
		patches: [],
		nextPatchId: 1,
		rootRendered: false,
		subscribers: new Set(),
		declaredSlotNames: new Set(["root", "status", "sidebar"]),
	};
}

export function renderToCanvas(session: CanvasSessionState, params: RenderParams): RenderResult {
	if (!isAllowedSelector(session, params.selector)) {
		return { ok: false, error: "selector_not_allowed" };
	}

	const sanitized = sanitizeCanvasHtml(params.html);
	if (!sanitized.ok) {
		return sanitized;
	}

	trackDeclaredSlots(session, sanitized.html);

	const emitted: CanvasPatch[] = [];
	if (params.selector === "#root" && !session.render.rootRendered) {
		session.render.rootRendered = true;
		emitted.push(
			pushPatch(session, {
				selector: "#canvas-empty-state",
				html: "",
				mode: "outer",
			}),
		);
	}

	emitted.push(
		pushPatch(session, {
			selector: params.selector,
			html: sanitized.html,
			mode: params.mode ?? "inner",
		}),
	);

	return {
		ok: true,
		patches: emitted,
	};
}

export function getQueuedPatches(session: CanvasSessionState, options?: { afterId?: number }): CanvasPatch[] {
	const afterId = options?.afterId ?? 0;
	if (afterId <= 0) return [...session.render.patches];
	return session.render.patches.filter((patch) => patch.id > afterId);
}

export function subscribeToPatches(session: CanvasSessionState, listener: (patch: CanvasPatch) => void): () => void {
	session.render.subscribers.add(listener);
	return () => {
		session.render.subscribers.delete(listener);
	};
}

function pushPatch(session: CanvasSessionState, patchInput: Omit<CanvasPatch, "id" | "timestamp">): CanvasPatch {
	const patch: CanvasPatch = {
		id: session.render.nextPatchId++,
		timestamp: new Date().toISOString(),
		...patchInput,
	};
	session.render.patches.push(patch);
	for (const subscriber of session.render.subscribers) {
		subscriber(patch);
	}
	return patch;
}

function isAllowedSelector(session: CanvasSessionState, selector: string): boolean {
	if (BUILTIN_SELECTORS.has(selector)) return true;
	if (/^#canvas-[a-z0-9_-]+$/i.test(selector)) return true;
	if (selector === "[data-canvas-slot]") return true;

	const slotMatch = selector.match(/^\[data-canvas-slot="([a-z0-9_-]+)"\]$/i);
	if (slotMatch) {
		return session.render.declaredSlotNames.has(slotMatch[1]!.toLowerCase());
	}

	return false;
}

function trackDeclaredSlots(session: CanvasSessionState, html: string): void {
	for (const match of html.matchAll(/\bdata-canvas-slot\s*=\s*("([^"]+)"|'([^']+)')/gi)) {
		const value = (match[2] ?? match[3] ?? "").trim().toLowerCase();
		if (value) session.render.declaredSlotNames.add(value);
	}
}
