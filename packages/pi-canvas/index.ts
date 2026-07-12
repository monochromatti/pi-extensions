import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openInBrowser } from "./src/browser.ts";
import { waitForEvent } from "./src/events.ts";
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
	ui?: {
		notify?: (message: string, level?: "info" | "error") => void;
		writeLine?: (line: string) => void;
	};
};

type CanvasCommandResult =
	| { ok: true; url: string; reused: boolean }
	| { ok: true; stopped: true }
	| { ok: true; enabled: boolean; running: boolean; url?: string }
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
			"The result lists declared slots and may include design-lint warnings: fix them in your next render.",
		promptSnippet: "canvas_render(selector, html, mode) - render UI into canvas after /canvas on",
		promptGuidelines: [
			"Canvas: patch the smallest slot that changed; never replace an element containing input the user may be typing into.",
			"Canvas: prefer <markdown-block> for prose over hand-written HTML; summarize important canvas feedback into chat before final output.",
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
		description: "Control canvas: /canvas on|open|off|status",
		handler: async (args: unknown, ctx: CanvasCommandContext) => {
			const argument = typeof args === "string" ? args.trim().toLowerCase() : "";
			if (argument === "on") return ensureCanvasRuntime(ctx);
			if (argument === "open") return ensureCanvasRuntime(ctx, true);
			if (argument === "off" || argument === "stop") return stopCanvasRuntime(ctx);
			if (argument === "status") return reportCanvasStatus(ctx);
			const error = "Usage: /canvas on | open | off | status";
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
				"Canvas demo rendered: try typing feedback and clicking the attention/checkpoint buttons in the sidebar.",
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

	pi.on("session_shutdown", async () => {
		if (!runtime) return;
		await runtime.stop();
		runtime = undefined;
		openedBrowser = false;
	});
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
		html: `Pi Canvas demo — rendering, feedback, and checkpoints`,
	});

	renderToCanvas(session, {
		selector: "#root",
		html: `<section id="canvas-overview" data-canvas-slot="overview">
	<header>
		<h1>Canvas showcase <span class="badge">interactive</span></h1>
		<p class="muted">Markdown, diagrams, diffs, and structured feedback — side by side with chat.</p>
	</header>

	<div class="grid">
		<article class="card">
			<h3>Markdown</h3>
			<markdown-block>Canvas renders **markdown** natively:

- headings, lists, tables
- inline \`code\`
- [links](https://example.com)

> Prefer this over hand-written HTML prose.</markdown-block>
		</article>

		<article class="card">
			<h3>Workflow map</h3>
			<mermaid-diagram>graph TD
	A[Ask] --> B[Render]
	B --> C[Feedback]
	C --> D[Revise]
	D --> E[Finalize]
			</mermaid-diagram>
		</article>
	</div>

	<article class="card" id="canvas-scope" data-canvas-slot="scope">
		<h3>Proposed change <span class="badge warning">draft</span></h3>
		<code-block language="diff">@@ -1,4 +1,5 @@
-Render plain text only
+Render semantic HTML
+Capture structured feedback
 Wait for explicit checkpoint
 Finalize artifact</code-block>
		<p class="muted">Note what should change in the sidebar, then send it back or approve.</p>
	</article>

	<aside class="callout info">
		Checkpoint buttons hand control back to the agent; attention buttons ask it to revise while it works.
	</aside>
</section>`,
	});

	renderToCanvas(session, {
		selector: "#sidebar",
		html: `<section id="canvas-controls" data-canvas-slot="controls">
	<h3>Your feedback</h3>
	<label class="field">
		Scope notes
		<textarea data-signal="feedback.section.scope" placeholder="What should change?"></textarea>
	</label>
	<label class="field">
		Priority
		<select data-signal="choice.priority">
			<option value="low">Low</option>
			<option value="medium" selected>Medium</option>
			<option value="high">High</option>
		</select>
	</label>
	<p class="muted" data-show="feedback.section.scope">The agent will read this note when you send it.</p>
	<div class="toolbar">
		<button data-event="attention:revise_scope" data-payload='{"source":"demo"}' data-enable-when="feedback.section.scope">Revise scope</button>
		<button data-event="checkpoint:approve_demo" data-payload='{"source":"demo"}'>Approve demo</button>
	</div>
</section>`,
	});
}

function sendCanvasMessage(pi: ExtensionAPI, summary: string, options?: CanvasMessageOptions): void {
	pi.sendUserMessage(summary, options);
}

function formatAttentionSummary(event: { name: string; payload?: unknown }): string {
	return `Canvas attention: ${formatEventName(event.name)}${formatPayloadHint(event.payload)}`;
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
