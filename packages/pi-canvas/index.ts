import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { waitForEvent } from "./src/events.ts";
import { renderToCanvas } from "./src/render.ts";
import { startCanvasServer, type CanvasServerRuntime } from "./src/server.ts";
import { createCanvasSession } from "./src/session.ts";
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
	startServer?: (session: ReturnType<typeof createCanvasSession>, options?: Parameters<typeof startCanvasServer>[1]) => Promise<CanvasServerRuntime>;
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
	| { ok: false; error: string };

export default function registerCanvasExtension(pi: ExtensionAPI, deps: CanvasCommandDeps = {}): void {
	const session = createCanvasSession();
	const startServer = deps.startServer ?? startCanvasServer;
	const openBrowser = deps.openBrowser ?? (() => {});
	let runtime: CanvasServerRuntime | undefined;
	let openedBrowser = false;

	pi.registerTool({
		name: "render",
		description: "Render HTML into canvas slot",
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
		name: "read_signals",
		description: "Read canvas signal store",
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
		name: "wait_for_event",
		description: "Wait for explicit canvas event",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string" },
				timeoutMs: { type: "number" },
			},
		},
		async execute(_toolCallId, params?: WaitForEventParams, signal?: AbortSignal) {
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
		description: "Open local collaboration canvas",
		handler: async (_args: unknown, ctx: CanvasCommandContext) => ensureCanvasRuntime(ctx),
	});

	pi.registerCommand("canvas-demo", {
		description: "Open canvas and render an interactive showcase",
		handler: async (_args: unknown, ctx: CanvasCommandContext) => {
			const ready = await ensureCanvasRuntime(ctx);
			if (!ready.ok) return ready;

			renderCanvasDemo(session);
			reportCanvasInfo(
				ctx,
				"Canvas demo rendered: try typing feedback and clicking the attention/checkpoint buttons in the sidebar.",
			);

			return ready;
		},
	});

	async function ensureCanvasRuntime(ctx: CanvasCommandContext): Promise<CanvasCommandResult> {
		const hadRuntime = Boolean(runtime);
		if (!runtime) {
			try {
				runtime = await startServer(session, {
					attentionPolicy: {
						isAgentActive: () => deps.isAgentActive?.() ?? true,
						formatSummary: formatAttentionSummary,
						onAttention: async (summary, options) => {
							sendCanvasMessage(pi, summary, options);
						},
					},
					onCheckpoint: async (summary) => {
						sendCanvasMessage(pi, summary);
					},
					formatCheckpointSummary,
				});
			} catch (error) {
				const message = `Canvas failed to start: ${errorMessage(error)}`;
				reportCanvasError(ctx, message);
				return { ok: false, error: errorMessage(error) };
			}
		}

		const url = runtime.url;
		reportCanvasInfo(ctx, `Canvas URL: ${url}`);
		reportCanvasInfo(ctx, canvasGuidanceText());

		if (!openedBrowser) {
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

	const piWithEvents = pi as ExtensionAPI & {
		on?: (name: string, handler: (...args: unknown[]) => unknown) => void;
	};
	piWithEvents.on?.("session_shutdown", async () => {
		if (!runtime) return;
		await runtime.stop();
		runtime = undefined;
		openedBrowser = false;
	});
}

function renderCanvasDemo(session: ReturnType<typeof createCanvasSession>): void {
	renderToCanvas(session, {
		selector: "#status",
		html: `<article class="callout"><strong>Pi Canvas demo</strong> <span class="badge">interactive</span></article>`,
	});

	renderToCanvas(session, {
		selector: "#root",
		html: `<section id="canvas-overview" data-canvas-slot="overview">
	<header>
		<h2>Canvas Showcase</h2>
		<p class="muted">This demo highlights semantic layout, Mermaid diagrams, code blocks, and signal/event controls.</p>
	</header>

	<div class="grid">
		<article>
			<h3>Workflow map</h3>
			<mermaid-diagram>graph TD
	A[Ask] --> B[Render]
	B --> C[Feedback]
	C --> D[Revise]
	D --> E[Finalize]
			</mermaid-diagram>
		</article>

		<article>
			<h3>Diff example</h3>
			<code-block language="diff">@@ -1,4 +1,5 @@
	-Render plain text only
	+Render semantic HTML
	+Capture structured feedback
	 Wait for explicit checkpoint
	 Finalize artifact</code-block>
		</article>
	</div>

	<article id="canvas-scope" data-canvas-slot="scope">
		<h3>Live feedback</h3>
		<p>Type in the sidebar, then click <strong>Revise scope</strong> or <strong>Approve demo</strong>.</p>
	</article>
</section>`,
	});

	renderToCanvas(session, {
		selector: "#sidebar",
		html: `<section id="canvas-controls" data-canvas-slot="controls">
	<h3>Controls</h3>
	<label>
		Scope notes
		<textarea data-signal="feedback.section.scope" placeholder="What should change?"></textarea>
	</label>
	<label>
		Priority
		<select data-signal="choice.priority">
			<option value="low">Low</option>
			<option value="medium" selected>Medium</option>
			<option value="high">High</option>
		</select>
	</label>
	<div class="grid">
		<button data-event="attention:revise_scope" data-payload='{"source":"demo"}'>Revise scope</button>
		<button data-event="checkpoint:approve_demo" data-payload='{"source":"demo"}'>Approve demo</button>
	</div>
</section>`,
	});
}

function sendCanvasMessage(
	pi: ExtensionAPI,
	summary: string,
	options?: { deliverAs?: "steer" },
): void {
	const sender = (pi as ExtensionAPI & {
		sendUserMessage?: (message: string, options?: { deliverAs?: "steer" }) => void;
		sendMessage?: (message: { content: string }, options?: { triggerTurn?: boolean }) => void;
	});
	if (typeof sender.sendUserMessage === "function") {
		sender.sendUserMessage(summary, options);
		return;
	}
	if (typeof sender.sendMessage === "function") {
		sender.sendMessage({ content: summary }, { triggerTurn: options?.deliverAs === "steer" });
	}
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
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
	const source = (payload as { source?: unknown }).source;
	if (typeof source === "string" && source.trim().length > 0) {
		return ` (${source.trim()})`;
	}
	return "";
}

function canvasGuidanceText(): string {
	return "Canvas workflow: use render(selector, html, mode), read_signals(), wait_for_event(). Canvas temporary; summarize important feedback in chat.";
}

function reportCanvasWarning(ctx: CanvasCommandContext, message: string): void {
	reportCanvasError(ctx, message);
}

function reportCanvasInfo(ctx: CanvasCommandContext, message: string): void {
	if (ctx?.ui?.notify) {
		ctx.ui.notify(message, "info");
		return;
	}
	ctx?.ui?.writeLine?.(message);
}

function reportCanvasError(ctx: CanvasCommandContext, message: string): void {
	if (ctx?.ui?.notify) {
		ctx.ui.notify(message, "error");
		return;
	}
	ctx?.ui?.writeLine?.(message);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
