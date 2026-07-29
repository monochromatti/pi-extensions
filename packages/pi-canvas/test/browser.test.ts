import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { waitForEvent } from "../src/events.ts";
import { renderToCanvas } from "../src/render.ts";
import { startCanvasServer } from "../src/server.ts";
import { createCanvasSession } from "../src/session.ts";

test("4.9 browser-style integration: root render patch updates #root DOM", async (t) => {
	const session = createCanvasSession();
	const runtime = await startCanvasServer(session);

	const dom = await JSDOM.fromURL(runtime.url, {
		runScripts: "dangerously",
		resources: "usable",
		pretendToBeVisual: true,
	});

	t.after(async () => {
		dom.window.close();
		await runtime.stop();
	});

	await waitFor(() => dom.window.document.readyState === "complete");
	assert.match(dom.window.document.querySelector("#root")?.textContent ?? "", /temporary work surface beside Pi chat/);

	const rendered = renderToCanvas(session, {
		selector: "#root",
		html: '<section id="spec-card">Spec draft v1</section>',
	});
	assert.equal(rendered.ok, true);

	await waitFor(() => (dom.window.document.querySelector("#root")?.textContent ?? "").includes("Spec draft v1"));

	assert.equal(dom.window.document.querySelector("#spec-card")?.textContent, "Spec draft v1");
	assert.equal(dom.window.document.querySelector("#canvas-empty-state"), null);
});

test("5.1 code-block renders escaped code, preserves text, exposes copy button", async (t) => {
	const session = createCanvasSession();
	const runtime = await startCanvasServer(session);

	const dom = await JSDOM.fromURL(runtime.url, {
		runScripts: "dangerously",
		resources: "usable",
		pretendToBeVisual: true,
	});

	t.after(async () => {
		dom.window.close();
		await runtime.stop();
	});

	let copied = "";
	Object.defineProperty(dom.window.navigator, "clipboard", {
		value: {
			writeText: async (text: string) => {
				copied = text;
			},
		},
		configurable: true,
	});

	const source = 'const html = "<strong>safe</strong>";\nconsole.log(html);';
	const encoded = source.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
	const rendered = renderToCanvas(session, {
		selector: "#root",
		html: `<code-block language="ts">${encoded}</code-block>`,
	});
	assert.equal(rendered.ok, true);

	await waitFor(() => Boolean(dom.window.document.querySelector("code-block button.copy-button")));

	const block = dom.window.document.querySelector("code-block");
	assert.ok(block);
	const code = block.querySelector("code");
	assert.ok(code);
	assert.equal(code?.textContent, source);
	assert.equal(block.querySelector("strong"), null);

	const button = block.querySelector("button.copy-button") as HTMLButtonElement | null;
	assert.ok(button);
	button.click();

	await waitFor(() => copied.length > 0);
	assert.equal(copied, source);
});

test("5.3 code-block language=diff renders add/del/context marker classes", async (t) => {
	const session = createCanvasSession();
	const runtime = await startCanvasServer(session);

	const dom = await JSDOM.fromURL(runtime.url, {
		runScripts: "dangerously",
		resources: "usable",
		pretendToBeVisual: true,
	});

	t.after(async () => {
		dom.window.close();
		await runtime.stop();
	});

	const diff = ["@@ -1,2 +1,2 @@", "-old line", "+new line", " context line"].join("\n");
	const rendered = renderToCanvas(session, {
		selector: "#root",
		html: `<code-block language="diff">${diff}</code-block>`,
	});
	assert.equal(rendered.ok, true);

	await waitFor(() => Boolean(dom.window.document.querySelector("code-block .diff-add")));

	const block = dom.window.document.querySelector("code-block");
	assert.ok(block);
	assert.equal(block.querySelectorAll(".diff-add").length, 1);
	assert.equal(block.querySelectorAll(".diff-del").length, 1);
	assert.equal(block.querySelectorAll(".diff-ctx").length, 2);
	assert.match(block.textContent ?? "", /\+new line/);
	assert.match(block.textContent ?? "", /-old line/);
});

test("5.5 mermaid-diagram renders container + safe error on invalid diagram without page crash", async (t) => {
	const session = createCanvasSession();
	const runtime = await startCanvasServer(session);

	const dom = await JSDOM.fromURL(runtime.url, {
		runScripts: "dangerously",
		resources: "usable",
		pretendToBeVisual: true,
	});

	t.after(async () => {
		dom.window.close();
		await runtime.stop();
	});

	(dom.window as unknown as { mermaid?: unknown }).mermaid = {
		initialize() {},
		render: async () => {
			throw new Error("invalid mermaid");
		},
	};

	const rendered = renderToCanvas(session, {
		selector: "#root",
		html: `<mermaid-diagram>graph TD\nA-->B</mermaid-diagram><p id="still-alive">alive</p>`,
	});
	assert.equal(rendered.ok, true);

	await waitFor(() => Boolean(dom.window.document.querySelector("mermaid-diagram .mermaid-container")));
	await waitFor(() => Boolean(dom.window.document.querySelector("mermaid-diagram .mermaid-error")));

	const container = dom.window.document.querySelector("mermaid-diagram .mermaid-container");
	assert.ok(container);
	assert.match(container?.textContent ?? "", /graph TD/);

	const error = dom.window.document.querySelector("mermaid-diagram .mermaid-error");
	assert.ok(error);
	assert.match(error?.textContent ?? "", /invalid mermaid|unavailable|failed/i);

	assert.equal(dom.window.document.querySelector("#still-alive")?.textContent, "alive");
	assert.equal(dom.window.document.body.textContent?.includes("alive"), true);
});

test("5.6 mermaid-diagram uses pinned jsdelivr mermaid loader and falls back safely when loader fails", async (t) => {
	const session = createCanvasSession();
	const runtime = await startCanvasServer(session);

	const dom = await JSDOM.fromURL(runtime.url, {
		runScripts: "dangerously",
		resources: "usable",
		pretendToBeVisual: true,
	});

	t.after(async () => {
		dom.window.close();
		await runtime.stop();
	});

	delete (dom.window as unknown as { mermaid?: unknown }).mermaid;

	const originalAppendChild = dom.window.document.head.appendChild.bind(dom.window.document.head);
	dom.window.document.head.appendChild = ((node: Node) => {
		const script = node as HTMLScriptElement;
		if (script.tagName === "SCRIPT" && script.dataset.piCanvasMermaid === "1") {
			setTimeout(() => script.onerror?.(new dom.window.Event("error")), 0);
		}
		return originalAppendChild(node);
	}) as typeof dom.window.document.head.appendChild;

	const rendered = renderToCanvas(session, {
		selector: "#root",
		html: "<mermaid-diagram>graph TD\nA-->B</mermaid-diagram>",
	});
	assert.equal(rendered.ok, true);

	await waitFor(() => Boolean(dom.window.document.querySelector("script[data-pi-canvas-mermaid='1']")));
	const loader = dom.window.document.querySelector("script[data-pi-canvas-mermaid='1']") as HTMLScriptElement | null;
	assert.ok(loader);
	assert.match(loader.src, /^https:\/\/cdn\.jsdelivr\.net\//);
	assert.match(loader.src, /\/npm\/mermaid@11\.16\.0\/dist\/mermaid\.min\.js$/);

	await waitFor(() => Boolean(dom.window.document.querySelector("mermaid-diagram .mermaid-error")));
	const error = dom.window.document.querySelector("mermaid-diagram .mermaid-error");
	assert.ok(error);
	assert.match(error?.textContent ?? "", /mermaid unavailable|failed/i);
});

test("8.3/8.4 browser full loop: sync input + checkpoint wait + targeted render preserves unrelated input", async (t) => {
	const session = createCanvasSession();
	const runtime = await startCanvasServer(session);

	const dom = await JSDOM.fromURL(runtime.url, {
		runScripts: "dangerously",
		resources: "usable",
		pretendToBeVisual: true,
	});

	t.after(async () => {
		dom.window.close();
		await runtime.stop();
	});

	const initial = renderToCanvas(session, {
		selector: "#root",
		html: `
			<section>
				<label for="global-feedback">Global feedback</label>
				<textarea id="global-feedback" data-signal="feedback.global"></textarea>
				<input id="unrelated-input" data-signal="input.unrelated" value="preserve-me" />
				<button id="submit-review" data-event="checkpoint:submit_review" data-payload='{"source":"form-submit","choice":"A"}'>Submit review</button>
				<div id="canvas-section" data-canvas-slot="section-area"><p>Initial section</p></div>
			</section>
		`,
	});
	assert.equal(initial.ok, true);

	await waitFor(() => Boolean(dom.window.document.querySelector("#global-feedback")));
	const textarea = dom.window.document.querySelector("#global-feedback") as HTMLTextAreaElement | null;
	const unrelatedInput = dom.window.document.querySelector("#unrelated-input") as HTMLInputElement | null;
	const submit = dom.window.document.querySelector("#submit-review") as HTMLButtonElement | null;
	assert.ok(textarea);
	assert.ok(unrelatedInput);
	assert.ok(submit);

	textarea.value = "Need tighter scope";
	textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

	unrelatedInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

	const waiting = waitForEvent(session, { name: "submit_review", timeoutMs: 1_000 });
	submit.click();

	const event = await waiting;
	assert.equal("timeout" in event, false);
	if ("timeout" in event) return;
	assert.equal(event.name, "submit_review");
	assert.deepEqual(event.payload, { source: "form-submit", choice: "A" });
	assert.deepEqual(event.signals, {
		"feedback.global": "Need tighter scope",
		"input.unrelated": "preserve-me",
	});
	assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T/);

	const update = renderToCanvas(session, {
		selector: "#canvas-section",
		html: "<p id=\"section-revised\">Revised section text</p>",
		mode: "inner",
	});
	assert.equal(update.ok, true);

	await waitFor(() => Boolean(dom.window.document.querySelector("#section-revised")));
	assert.equal(dom.window.document.querySelector("#section-revised")?.textContent, "Revised section text");
	assert.equal((dom.window.document.querySelector("#global-feedback") as HTMLTextAreaElement | null)?.value, "Need tighter scope");
	assert.equal((dom.window.document.querySelector("#unrelated-input") as HTMLInputElement | null)?.value, "preserve-me");
});

async function waitFor(condition: () => boolean, timeoutMs = 2_000, stepMs = 25): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
	throw new Error("Condition not met before timeout");
}

test("5.8 markdown-block renders markdown via marked and sanitizes dangerous HTML", async (t) => {
	const session = createCanvasSession();
	const runtime = await startCanvasServer(session);

	const dom = await JSDOM.fromURL(runtime.url, {
		runScripts: "dangerously",
		resources: "usable",
		pretendToBeVisual: true,
	});

	t.after(async () => {
		dom.window.close();
		await runtime.stop();
	});

	type MarkedWindow = { marked?: { parse: (source: string, options?: unknown) => string } };
	// jsdom's Window type doesn't model page globals; components.js reads window.marked.
	const pageWindow = dom.window as unknown as MarkedWindow;
	pageWindow.marked = {
		parse: () =>
			'<h2>Title</h2><script>window.pwned = true;</script>' +
			'<a href="javascript:alert(1)" onclick="steal()">link</a>' +
			'<p style="color:red">body</p><ul><li>item</li></ul>',
	};

	const rendered = renderToCanvas(session, {
		selector: "#root",
		html: "<markdown-block>## Title\n\n- item</markdown-block>",
	});
	assert.equal(rendered.ok, true);

	await waitFor(() => Boolean(dom.window.document.querySelector("markdown-block .markdown-body h2")));

	const body = dom.window.document.querySelector("markdown-block .markdown-body");
	assert.ok(body);
	assert.equal(body?.querySelector("h2")?.textContent, "Title");
	assert.equal(body?.querySelector("li")?.textContent, "item");

	assert.equal(body?.querySelector("script"), null);
	const link = body?.querySelector("a");
	assert.ok(link);
	assert.equal(link?.hasAttribute("href"), false);
	assert.equal(link?.hasAttribute("onclick"), false);
	assert.equal(body?.querySelector("p")?.hasAttribute("style"), false);
});

test("5.9 markdown-block uses pinned jsdelivr marked loader and falls back to source text", async (t) => {
	const session = createCanvasSession();
	const runtime = await startCanvasServer(session);

	const dom = await JSDOM.fromURL(runtime.url, {
		runScripts: "dangerously",
		resources: "usable",
		pretendToBeVisual: true,
	});

	t.after(async () => {
		dom.window.close();
		await runtime.stop();
	});

	const originalAppendChild = dom.window.document.head.appendChild.bind(dom.window.document.head);
	dom.window.document.head.appendChild = ((node: Node) => {
		const script = node as HTMLScriptElement;
		if (script.tagName === "SCRIPT" && script.dataset.piCanvasMarked === "1") {
			setTimeout(() => script.onerror?.(new dom.window.Event("error")), 0);
		}
		return originalAppendChild(node);
	}) as typeof dom.window.document.head.appendChild;

	const source = "## Draft\n\nplain fallback text";
	const rendered = renderToCanvas(session, {
		selector: "#root",
		html: `<markdown-block>${source}</markdown-block>`,
	});
	assert.equal(rendered.ok, true);

	await waitFor(() => Boolean(dom.window.document.querySelector("script[data-pi-canvas-marked='1']")));
	const loader = dom.window.document.querySelector("script[data-pi-canvas-marked='1']") as HTMLScriptElement | null;
	assert.ok(loader);
	assert.match(loader.src, /^https:\/\/cdn\.jsdelivr\.net\//);
	assert.match(loader.src, /\/npm\/marked@12\.0\.2\/marked\.min\.js$/);

	await waitFor(() => Boolean(dom.window.document.querySelector("markdown-block .markdown-fallback")));
	const fallback = dom.window.document.querySelector("markdown-block .markdown-fallback");
	assert.equal(fallback?.textContent, source);
});

test("5.10 data-show and data-enable-when react to signal edits without expressions", async (t) => {
	const session = createCanvasSession();
	const runtime = await startCanvasServer(session);

	const dom = await JSDOM.fromURL(runtime.url, {
		runScripts: "dangerously",
		resources: "usable",
		pretendToBeVisual: true,
	});

	t.after(async () => {
		dom.window.close();
		await runtime.stop();
	});

	const rendered = renderToCanvas(session, {
		selector: "#root",
		html: `
			<section>
				<textarea id="notes" data-signal="feedback.notes"></textarea>
				<p id="hint" data-show="feedback.notes">will send</p>
				<p id="nudge" data-show="!feedback.notes">type something</p>
				<button id="send" data-event="attention:send" data-enable-when="feedback.notes">Send</button>
				<p id="ignored" data-show="feedback.notes == 'x'">never toggled</p>
			</section>
		`,
	});
	assert.equal(rendered.ok, true);

	await waitFor(() => Boolean(dom.window.document.querySelector("#send")));
	const hint = dom.window.document.querySelector("#hint") as HTMLElement;
	const nudge = dom.window.document.querySelector("#nudge") as HTMLElement;
	const send = dom.window.document.querySelector("#send") as HTMLButtonElement;
	const ignored = dom.window.document.querySelector("#ignored") as HTMLElement;
	const notes = dom.window.document.querySelector("#notes") as HTMLTextAreaElement;

	// Initial pass after the patch applies: empty signal hides/disables.
	assert.equal(hint.hidden, true);
	assert.equal(nudge.hidden, false);
	assert.equal(send.disabled, true);
	assert.equal(ignored.hidden, false);

	notes.value = "tighter scope";
	notes.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

	await waitFor(() => hint.hidden === false);
	assert.equal(nudge.hidden, true);
	assert.equal(send.disabled, false);
	// Malformed expression stays inert.
	assert.equal(ignored.hidden, false);

	notes.value = "";
	notes.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

	await waitFor(() => hint.hidden === true);
	assert.equal(nudge.hidden, false);
	assert.equal(send.disabled, true);
});

test("10.1 selecting rendered text produces a comment with quote, slot, and note", async (t) => {
	const session = createCanvasSession();
	const attention: Array<{ name: string; payload?: unknown }> = [];
	const runtime = await startCanvasServer(session, {
		attentionPolicy: {
			onAttention: (_summary, _options, event) => {
				if (event) attention.push({ name: event.name, payload: event.payload });
			},
		},
	});

	const dom = await JSDOM.fromURL(runtime.url, {
		runScripts: "dangerously",
		resources: "usable",
		pretendToBeVisual: true,
	});

	t.after(async () => {
		dom.window.close();
		await runtime.stop();
	});

	const rendered = renderToCanvas(session, {
		selector: "#root",
		html: '<section data-canvas-slot="design"><p id="claim">Refresh happens on the first 401.</p></section>',
	});
	assert.equal(rendered.ok, true);

	await waitFor(() => Boolean(dom.window.document.querySelector("#claim")));

	const claim = dom.window.document.querySelector("#claim")!;
	const range = dom.window.document.createRange();
	range.selectNodeContents(claim);
	const selection = dom.window.getSelection()!;
	selection.removeAllRanges();
	selection.addRange(range);
	dom.window.document.dispatchEvent(new dom.window.Event("mouseup", { bubbles: true }));

	await waitFor(() => {
		const pill = dom.window.document.querySelector(".canvas-comment-pill") as HTMLElement | null;
		return Boolean(pill) && pill!.hidden === false;
	});

	(dom.window.document.querySelector(".canvas-comment-pill") as HTMLElement).click();
	await waitFor(() => Boolean(dom.window.document.querySelector(".canvas-comment-composer")));

	const composer = dom.window.document.querySelector(".canvas-comment-composer") as HTMLElement;
	assert.equal(composer.hidden, false);
	assert.match(composer.querySelector(".canvas-comment-quote")?.textContent ?? "", /Refresh happens on the first 401/);

	const input = composer.querySelector(".canvas-comment-input") as HTMLTextAreaElement;
	input.value = "Second 401 should bail, say so here.";
	(composer.querySelector(".canvas-comment-send") as HTMLButtonElement).click();

	await waitFor(() => attention.length > 0);
	assert.equal(attention[0]?.name, "comment");
	assert.deepEqual(
		{ ...(attention[0]?.payload as Record<string, unknown>), at: undefined },
		{
			kind: "selection-comment",
			index: 1,
			slot: "design",
			quote: "Refresh happens on the first 401.",
			note: "Second 401 should bail, say so here.",
			at: undefined,
		},
	);

	// The comment is also readable as a signal, so the agent can catch up later.
	const comments = session.signals.comments as Array<{ note: string }>;
	assert.equal(comments.length, 1);
	assert.equal(comments[0]?.note, "Second 401 should bail, say so here.");

	// The composer closes after sending and never lives inside a patchable slot.
	assert.equal((dom.window.document.querySelector(".canvas-comment-composer") as HTMLElement).hidden, true);
	assert.equal(dom.window.document.querySelector("#root .canvas-comment-composer"), null);
});

test("10.1 selections in form controls do not show comment pill", async (t) => {
	const session = createCanvasSession();
	const runtime = await startCanvasServer(session);
	const dom = await JSDOM.fromURL(runtime.url, {
		runScripts: "dangerously",
		resources: "usable",
		pretendToBeVisual: true,
	});

	t.after(async () => {
		dom.window.close();
		await runtime.stop();
	});

	assert.equal(renderToCanvas(session, { selector: "#root", html: '<textarea id="notes">editable agent text</textarea>' }).ok, true);
	await waitFor(() => Boolean(dom.window.document.querySelector("#notes")));
	const notes = dom.window.document.querySelector("#notes")!;
	const range = dom.window.document.createRange();
	range.selectNodeContents(notes);
	const selection = dom.window.getSelection()!;
	selection.removeAllRanges();
	selection.addRange(range);
	dom.window.document.dispatchEvent(new dom.window.Event("mouseup", { bubbles: true }));
	await new Promise((resolve) => dom.window.setTimeout(resolve, 20));

	assert.equal(dom.window.document.querySelector(".canvas-comment-pill"), null);
});

test("10.1 Escape dismisses visible comment pill without opening composer", async (t) => {
	const session = createCanvasSession();
	const runtime = await startCanvasServer(session);
	const dom = await JSDOM.fromURL(runtime.url, {
		runScripts: "dangerously",
		resources: "usable",
		pretendToBeVisual: true,
	});

	t.after(async () => {
		dom.window.close();
		await runtime.stop();
	});

	assert.equal(renderToCanvas(session, { selector: "#root", html: '<p id="claim">Selectable rendered text</p>' }).ok, true);
	await waitFor(() => Boolean(dom.window.document.querySelector("#claim")));
	const range = dom.window.document.createRange();
	range.selectNodeContents(dom.window.document.querySelector("#claim")!);
	const selection = dom.window.getSelection()!;
	selection.removeAllRanges();
	selection.addRange(range);
	dom.window.document.dispatchEvent(new dom.window.Event("mouseup", { bubbles: true }));
	await waitFor(() => (dom.window.document.querySelector(".canvas-comment-pill") as HTMLElement | null)?.hidden === false);

	dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	assert.equal((dom.window.document.querySelector(".canvas-comment-pill") as HTMLElement).hidden, true);
	assert.equal((dom.window.document.querySelector(".canvas-comment-composer") as HTMLElement).hidden, true);
});

test("10.9 a patch that replaces the quoted text dismisses the open composer", async (t) => {
	const session = createCanvasSession();
	const runtime = await startCanvasServer(session);

	const dom = await JSDOM.fromURL(runtime.url, {
		runScripts: "dangerously",
		resources: "usable",
		pretendToBeVisual: true,
	});

	t.after(async () => {
		dom.window.close();
		await runtime.stop();
	});

	renderToCanvas(session, {
		selector: "#root",
		html: '<section id="canvas-claim" data-canvas-slot="claim"><p id="claim">Refresh happens on the first 401.</p></section>',
	});
	await waitFor(() => Boolean(dom.window.document.querySelector("#claim")));

	const range = dom.window.document.createRange();
	range.selectNodeContents(dom.window.document.querySelector("#claim")!);
	const selection = dom.window.getSelection()!;
	selection.removeAllRanges();
	selection.addRange(range);
	dom.window.document.dispatchEvent(new dom.window.Event("mouseup", { bubbles: true }));

	await waitFor(() => (dom.window.document.querySelector(".canvas-comment-pill") as HTMLElement | null)?.hidden === false);
	(dom.window.document.querySelector(".canvas-comment-pill") as HTMLElement).click();
	await waitFor(() => (dom.window.document.querySelector(".canvas-comment-composer") as HTMLElement | null)?.hidden === false);

	renderToCanvas(session, {
		selector: "#canvas-claim",
		html: '<p id="claim-2">Refresh happens on every 401.</p>',
		mode: "inner",
	});

	await waitFor(() => Boolean(dom.window.document.querySelector("#claim-2")));
	await waitFor(() => (dom.window.document.querySelector(".canvas-comment-composer") as HTMLElement).hidden === true);
	assert.match(dom.window.document.querySelector(".canvas-comment-toast")?.textContent ?? "", /selection changed/i);
});
