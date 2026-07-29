import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openInBrowser } from "./src/browser.ts";
import { waitForEvent } from "./src/events.ts";
import { exportCanvas } from "./src/export.ts";
import { renderToCanvas } from "./src/render.ts";
import { startCanvasServer, type CanvasServerOptions, type CanvasServerRuntime } from "./src/server.ts";
import { createCanvasSession, type CanvasSessionState } from "./src/session.ts";
import { readSignals } from "./src/signals.ts";

type RenderParams = {
	selector: string;
	html: string;
	mode?: "inner" | "outer" | "append" | "prepend";
};

type ReadSignalsParams = {
	keys?: string[];
};

type WaitForEventParams = {
	name?: string;
	timeoutMs?: number;
};

type CanvasCommandDeps = {
	startServer?: (session: CanvasSessionState, options?: CanvasServerOptions) => Promise<CanvasServerRuntime>;
	openBrowser?: (url: string) => void | Promise<void>;
	isAgentActive?: () => boolean;
};

type CanvasCommandContext = {
	cwd?: string;
	ui?: {
		notify?: (message: string, level?: "info" | "error") => void;
		writeLine?: (line: string) => void;
	};
};

type CanvasCommandResult =
	| { ok: true; url: string; reused: boolean }
	| { ok: true; stopped: true }
	| { ok: true; enabled: boolean; running: boolean; url?: string }
	| { ok: true; exported: true; path: string; patchCount: number }
	| { ok: false; error: string };

type CanvasMessageOptions = { deliverAs?: "steer" | "followUp" };

export default function registerCanvasExtension(pi: ExtensionAPI, deps: CanvasCommandDeps = {}): void {
	const session = createCanvasSession();
	const startServer = deps.startServer ?? startCanvasServer;
	const openBrowser = deps.openBrowser ?? openInBrowser;
	let runtime: CanvasServerRuntime | undefined;
	let openedBrowser = false;
	let canvasEnabled = false;

	// Track streaming state so canvas events know whether to steer the agent
	// mid-turn or trigger a fresh turn. deps.isAgentActive overrides for tests.
	let agentStreaming = false;
	pi.on("agent_start", () => {
		agentStreaming = true;
	});
	pi.on("agent_end", () => {
		agentStreaming = false;
	});
	const isAgentActive = () => deps.isAgentActive?.() ?? agentStreaming;

	pi.registerTool({
		name: "canvas_render",
		label: "Canvas render",
		description:
			"Render content into the local collaboration canvas after the user enables it with /canvas on. " +
			"Targets a slot selector (#root, #status, #sidebar, #canvas-* ids, or [data-canvas-slot=\"name\"]); " +
			"modes: inner (default), outer, append, prepend. HTML is sanitized (no scripts/styles/handlers). " +
			"Semantic HTML is styled automatically; the only classes with styles are: card, callout, warning, success, danger, info, grid, stack, row, toolbar, field, muted, badge, btn-primary, btn-quiet. " +
			"Use <markdown-block> for prose, <code-block language=\"ts|diff|...\"> for code, <mermaid-diagram> for diagrams. " +
			"Collect user input with data-signal attributes and buttons like data-event=\"attention:name\" or data-event=\"checkpoint:name\"; " +
			"data-show=\"<signal key>\" and data-enable-when=\"<signal key>\" toggle visibility/enablement from signals. " +
			"Users can select any rendered text and comment on it, so render controls only for real decisions. " +
			"The result lists declared slots and may include design-lint warnings: fix them in your next render.",
		promptSnippet: "canvas_render(selector, html, mode) - render compact visual UI into canvas after /canvas on",
		promptGuidelines: [
			"Canvas: compress information — tables, diagrams, diffs, badges, short bullets. Prose paragraphs are the last resort, not the default.",
			"Canvas: freeform feedback is built in (users select text and comment). Render inputs only for open decisions the user must settle; skip generic feedback panels.",
			"Canvas: patch the smallest slot that changed; never replace an element containing input the user may be typing into.",
			"Canvas: semantic HTML is auto-styled; use only documented helper classes (inline styles are stripped) and fix any warnings canvas_render returns.",
		],
		parameters: {
			type: "object",
			properties: {
				selector: { type: "string" },
				html: { type: "string" },
				mode: { type: "string", enum: ["inner", "outer", "append", "prepend"] },
			},
			required: ["selector", "html"],
		},
		async execute(_toolCallId, params?: RenderParams) {
			if (!canvasEnabled) return disabledToolResult();
			if (!params?.selector || typeof params.html !== "string") {
				return {
					content: [{ type: "text", text: JSON.stringify({ ok: false, error: "selector and html required" }) }],
					details: { ok: false, error: "selector and html required" },
				};
			}

			const result = renderToCanvas(session, {
				selector: params.selector,
				html: params.html,
				mode: params.mode,
			});
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "canvas_read_signals",
		label: "Canvas signals",
		description:
			"Read the canvas signal store: current values of inputs the user edited in the canvas " +
			"(elements with data-signal attributes). Pass keys to select specific signals; omit for all.",
		promptSnippet: "canvas_read_signals(keys?) - read values the user typed into canvas inputs",
		parameters: {
			type: "object",
			properties: {
				keys: { type: "array", items: { type: "string" } },
			},
		},
		async execute(_toolCallId, params?: ReadSignalsParams) {
			const signals = readSignals(session, { keys: params?.keys });
			return {
				content: [{ type: "text", text: JSON.stringify({ signals }) }],
				details: { signals },
			};
		},
	});

	pi.registerTool({
		name: "canvas_wait_for_event",
		label: "Canvas wait",
		description:
			"Wait until the user clicks a canvas checkpoint button (data-event=\"checkpoint:<name>\"). " +
			"Optional name filter and timeoutMs cap. Returns the event with a signals snapshot, or {timeout:true}.",
		promptSnippet: "canvas_wait_for_event(name?, timeoutMs?) - block until the user clicks a canvas checkpoint button",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string" },
				timeoutMs: { type: "number" },
			},
		},
		async execute(_toolCallId, params?: WaitForEventParams, signal?: AbortSignal) {
			if (!canvasEnabled) return disabledToolResult();
			const result = await waitForEvent(session, {
				name: params?.name,
				timeoutMs: params?.timeoutMs,
				signal,
			});
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: result,
			};
		},
	});

	pi.registerCommand("canvas", {
		description: "Control canvas: /canvas on|open|off|status|export [path]",
		handler: async (args: unknown, ctx: CanvasCommandContext) => {
			const { command, rest } = parseCanvasCommand(args);
			if (command === "on") return ensureCanvasRuntime(ctx);
			if (command === "open") return ensureCanvasRuntime(ctx, true);
			if (command === "off" || command === "stop") return stopCanvasRuntime(ctx);
			if (command === "status") return reportCanvasStatus(ctx);
			if (command === "export") {
				const parsedPath = parseCanvasExportPath(rest);
				if (!parsedPath.ok) {
					reportCanvasWarning(ctx, parsedPath.error);
					return parsedPath;
				}
				return exportCanvasSnapshot(ctx, parsedPath.value);
			}
			const error = "Usage: /canvas on | open | off | status | export [path]";
			reportCanvasWarning(ctx, error);
			return { ok: false, error };
		},
	});

	pi.registerCommand("canvas-demo", {
		description: "Open canvas and render an interactive showcase",
		handler: async (_args: unknown, ctx: CanvasCommandContext) => {
			const ready = await ensureCanvasRuntime(ctx, true);
			if (!ready.ok) return ready;

			renderCanvasDemo(session);
			reportCanvasInfo(
				ctx,
				"Canvas demo rendered: select any text to comment on it, or pick a strategy and confirm in the sidebar.",
			);

			return ready;
		},
	});

	async function ensureCanvasRuntime(ctx: CanvasCommandContext, forceOpen = false): Promise<CanvasCommandResult> {
		canvasEnabled = true;
		const hadRuntime = Boolean(runtime);
		if (!runtime) {
			try {
				runtime = await startServer(session, {
					attentionPolicy: {
						isAgentActive,
						formatSummary: formatAttentionSummary,
						onAttention: async (summary, options) => {
							sendCanvasMessage(pi, summary, options);
						},
					},
					// Only fires when no canvas_wait_for_event waiter consumed the
					// checkpoint; queue behind the current turn when streaming.
					onCheckpoint: async (summary) => {
						sendCanvasMessage(pi, summary, isAgentActive() ? { deliverAs: "followUp" } : undefined);
					},
					formatCheckpointSummary,
				});
			} catch (error) {
				canvasEnabled = false;
				const message = `Canvas failed to start: ${errorMessage(error)}`;
				reportCanvasError(ctx, message);
				return { ok: false, error: errorMessage(error) };
			}
		}

		const url = runtime.url;
		reportCanvasInfo(ctx, `Canvas URL: ${url}`);
		reportCanvasInfo(ctx, canvasGuidanceText());

		if (forceOpen || !openedBrowser) {
			try {
				await openBrowser(url);
				openedBrowser = true;
			} catch (error) {
				reportCanvasWarning(
					ctx,
					`Canvas browser open failed. Run /canvas again or open URL manually. ${errorMessage(error)}`,
				);
			}
		}

		return { ok: true, url, reused: hadRuntime };
	}

	async function stopCanvasRuntime(ctx: CanvasCommandContext): Promise<CanvasCommandResult> {
		canvasEnabled = false;
		if (!runtime) {
			reportCanvasInfo(ctx, "Canvas is off.");
			return { ok: true, stopped: true };
		}

		try {
			await runtime.stop();
		} catch (error) {
			const message = `Canvas failed to stop: ${errorMessage(error)}`;
			reportCanvasError(ctx, message);
			return { ok: false, error: errorMessage(error) };
		}

		runtime = undefined;
		openedBrowser = false;
		reportCanvasInfo(ctx, "Canvas is off.");
		return { ok: true, stopped: true };
	}

	function reportCanvasStatus(ctx: CanvasCommandContext): CanvasCommandResult {
		const result = { ok: true as const, enabled: canvasEnabled, running: Boolean(runtime), url: runtime?.url };
		reportCanvasInfo(ctx, canvasEnabled ? `Canvas is on${runtime ? `: ${runtime.url}` : "."}` : "Canvas is off.");
		return result;
	}

	async function exportCanvasSnapshot(ctx: CanvasCommandContext, requestedPath: string): Promise<CanvasCommandResult> {
		const baseDir = ctx.cwd ?? process.cwd();
		const outputPath = requestedPath || defaultCanvasExportName();
		try {
			const result = await exportCanvas(session, {
				outputPath: resolveCanvasExportPath(baseDir, outputPath),
			});
			reportCanvasInfo(ctx, `Canvas exported: ${result.path} (${result.patchCount} patches)`);
			return { ok: true, exported: true, ...result };
		} catch (error) {
			const message = `Canvas export failed: ${errorMessage(error)}`;
			reportCanvasError(ctx, message);
			return { ok: false, error: errorMessage(error) };
		}
	}

	pi.on("session_shutdown", async () => {
		if (!runtime) return;
		await runtime.stop();
		runtime = undefined;
		openedBrowser = false;
	});
}

function parseCanvasCommand(args: unknown): { command: string; rest: string } {
	if (typeof args !== "string") return { command: "", rest: "" };
	const trimmed = args.trim();
	if (!trimmed) return { command: "", rest: "" };
	const separator = trimmed.search(/\s/);
	if (separator < 0) return { command: trimmed.toLowerCase(), rest: "" };
	return {
		command: trimmed.slice(0, separator).toLowerCase(),
		rest: trimmed.slice(separator).trim(),
	};
}

function parseCanvasExportPath(value: string): { ok: true; value: string } | { ok: false; error: string } {
	if (!value || (value[0] !== '"' && value[0] !== "'")) return { ok: true, value };
	const quote = value[0];
	let parsed = "";
	for (let index = 1; index < value.length; index++) {
		const character = value[index];
		if (character === "\\" && index + 1 < value.length) {
			const next = value[index + 1];
			if (next === quote || next === "\\") {
				parsed += next;
				index += 1;
				continue;
			}
		}
		if (character !== quote) {
			parsed += character;
			continue;
		}
		if (value.slice(index + 1).trim()) {
			return { ok: false, error: "Canvas export path has text after closing quote." };
		}
		return { ok: true, value: parsed };
	}
	return { ok: false, error: "Canvas export path has an unmatched quote." };
}

function resolveCanvasExportPath(baseDir: string, requestedPath: string): string {
	const root = path.resolve(baseDir);
	const outputPath = path.resolve(root, requestedPath);
	const relative = path.relative(root, outputPath);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error("Export path must stay within current working directory");
	}
	return outputPath;
}

function defaultCanvasExportName(now = new Date()): string {
	const timestamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
	return `canvas-export-${timestamp}.html`;
}

function disabledToolResult() {
	const details = { ok: false, error: "Canvas is off. Run /canvas on." };
	return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

// The demo doubles as the pattern library: every component, helper class,
// and interaction primitive, composed the way the skill's recipes teach.
// Keep it lint-clean — it is the exemplar agents imitate.
function renderCanvasDemo(session: CanvasSessionState): void {
	renderToCanvas(session, {
		selector: "#status",
		html: `Canvas demo — select any text to comment; sidebar holds the open decision`,
	});

	renderToCanvas(session, {
		selector: "#root",
		html: `<section id="canvas-overview" data-canvas-slot="overview">
	<h1>Token refresh <span class="badge warning">draft</span></h1>

	<markdown-block>| Option | Ops cost | Failure mode | Fit |
| --- | --- | --- | --- |
| Refresh on 401 | low | retry storm | default |
| Background timer | medium | clock skew | long sessions |
| Re-auth prompt | none | user friction | fallback |</markdown-block>

	<section id="canvas-flow" data-canvas-slot="flow">
		<h2>Flow</h2>
		<mermaid-diagram>sequenceDiagram
	Client->>API: request
	API-->>Client: 401
	Client->>API: refresh(token)
	API-->>Client: 200 {token'}
		</mermaid-diagram>
	</section>

	<section id="canvas-change" data-canvas-slot="change">
		<h2>Change</h2>
		<code-block language="diff">@@ -12,3 +12,6 @@
-const res = await fetch(url);
+const res = await fetchWithRetry(url, { on: [401] });</code-block>
		<aside class="callout warning">Second 401 bails instead of looping.</aside>
	</section>
</section>`,
	});

	renderToCanvas(session, {
		selector: "#sidebar",
		html: `<section id="canvas-decision" data-canvas-slot="decision">
	<h3>Open decision</h3>
	<fieldset>
		<legend>Refresh strategy</legend>
		<label><input type="radio" name="strategy" value="on-401" data-signal="choice.strategy" /> Refresh on 401</label>
		<label><input type="radio" name="strategy" value="timer" data-signal="choice.strategy" /> Background timer</label>
	</fieldset>
	<p class="muted">Everything else: select text in the document and comment on it.</p>
	<div class="toolbar">
		<button data-event="checkpoint:pick_strategy" data-payload='{"source":"demo"}' data-enable-when="choice.strategy">Confirm choice</button>
	</div>
</section>`,
	});
}

function sendCanvasMessage(pi: ExtensionAPI, summary: string, options?: CanvasMessageOptions): void {
	pi.sendUserMessage(summary, options);
}

function formatAttentionSummary(event: { name: string; payload?: unknown; source?: string }): string {
	const comment = readSelectionComment(event);
	if (comment) {
		const where = comment.slot ? ` [${comment.slot}]` : "";
		return `Canvas comment${where} on "${comment.quote}": ${comment.note}`;
	}
	return `Canvas attention: ${formatEventName(event.name)}${formatPayloadHint(event.payload)}`;
}

type SelectionComment = { slot?: string; quote: string; note: string };

/**
 * Only the server-set source marks a real selection comment. An agent-rendered
 * attention button can post any payload it likes, so payload shape alone must
 * never decide how text enters the transcript.
 */
function readSelectionComment(event: { payload?: unknown; source?: string }): SelectionComment | undefined {
	if (event.source !== "selection-comment") return undefined;
	if (!event.payload || typeof event.payload !== "object") return undefined;
	const record = event.payload as Record<string, unknown>;
	const quote = typeof record.quote === "string" ? collapse(record.quote, 200) : "";
	const note = typeof record.note === "string" ? collapse(record.note, 800) : "";
	if (!quote || !note) return undefined;
	const rawSlot = typeof record.slot === "string" ? record.slot.trim() : "";
	const slot = /^[a-z0-9_-]{1,40}$/i.test(rawSlot) ? rawSlot : undefined;
	return { slot, quote, note };
}

function collapse(value: string, maxChars: number): string {
	const text = value.replace(/\s+/g, " ").trim();
	return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function formatCheckpointSummary(event: { name: string; payload?: unknown }): string {
	return `Canvas checkpoint: ${formatEventName(event.name)}${formatPayloadHint(event.payload)}`;
}

function formatEventName(name: string): string {
	return name.trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function formatPayloadHint(payload: unknown): string {
	if (!payload || typeof payload !== "object" || !("source" in payload)) return "";
	const source = payload.source;
	if (typeof source === "string" && source.trim().length > 0) {
		return ` (${source.trim()})`;
	}
	return "";
}

function canvasGuidanceText(): string {
	return "Canvas workflow: use canvas_render(selector, html, mode), canvas_read_signals(), canvas_wait_for_event(). Canvas is temporary; summarize important feedback in chat.";
}

function reportCanvasWarning(ctx: CanvasCommandContext, message: string): void {
	reportCanvasError(ctx, message);
}

function reportCanvasInfo(ctx: CanvasCommandContext, message: string): void {
	if (ctx.ui?.notify) {
		ctx.ui.notify(message, "info");
		return;
	}
	ctx.ui?.writeLine?.(message);
}

function reportCanvasError(ctx: CanvasCommandContext, message: string): void {
	if (ctx.ui?.notify) {
		ctx.ui.notify(message, "error");
		return;
	}
	ctx.ui?.writeLine?.(message);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
