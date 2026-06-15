import assert from "node:assert/strict";
import test from "node:test";
import registerCanvasExtension from "../index.ts";
import { pushAttentionEvent } from "../src/events.ts";
import { createCanvasSession } from "../src/session.ts";
import type { CanvasServerOptions } from "../src/server.ts";

function createFakePi() {
	const tools: Array<{ name: string; execute?: (...args: unknown[]) => Promise<unknown> }> = [];
	const commands: Array<{ name: string; handler?: (...args: unknown[]) => Promise<unknown> }> = [];
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const sendUserMessages: Array<{ message: string; options?: { deliverAs?: "steer" } }> = [];
	const pi = {
		registerTool(tool: { name: string; execute?: (...args: unknown[]) => Promise<unknown> }) {
			tools.push(tool);
		},
		registerCommand(name: string, spec?: { handler?: (...args: unknown[]) => Promise<unknown> }) {
			commands.push({ name, handler: spec?.handler });
		},
		on(name: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(name, handler);
		},
		sendUserMessage(message: string, options?: { deliverAs?: "steer" }) {
			sendUserMessages.push({ message, options });
		},
	};
	return {
		pi: pi as any,
		tools,
		commands,
		sendUserMessages,
		getCommand(name: string) {
			return commands.find((command) => command.name === name);
		},
		async emit(name: string, ...args: unknown[]) {
			const handler = handlers.get(name);
			if (!handler) return undefined;
			return await handler(...args);
		},
		getSendUserMessageCalls: () => sendUserMessages.length,
	};
}

test("1.3 extension registers /canvas and only canvas tool surface", () => {
	const fake = createFakePi();
	registerCanvasExtension(fake.pi);

	assert.deepEqual(fake.commands.map((command) => command.name), ["canvas", "canvas-demo"]);
	assert.deepEqual(
		fake.tools.map((tool) => tool.name).sort(),
		["read_signals", "render", "wait_for_event"],
	);
});

test("1.4 /canvas-demo opens canvas and queues showcase patches", async () => {
	const fake = createFakePi();
	registerCanvasExtension(fake.pi);

	const canvasDemo = fake.getCommand("canvas-demo");
	assert.ok(canvasDemo?.handler);

	try {
		const result = (await canvasDemo.handler?.([], { ui: {} })) as { ok: boolean; url?: string };
		assert.equal(result.ok, true);
		assert.equal(typeof result.url, "string");

		const demoUrl = new URL(result.url!);
		const token = demoUrl.searchParams.get("token");
		assert.equal(typeof token, "string");

		const patchesResponse = await fetch(`${demoUrl.origin}/patches?token=${encodeURIComponent(token ?? "")}`);
		assert.equal(patchesResponse.status, 200);
		const patchesBody = (await patchesResponse.json()) as {
			patches: Array<{ selector: string; html: string }>;
		};

		assert.equal(patchesBody.patches.some((patch) => patch.selector === "#status" && /Pi Canvas demo/.test(patch.html)), true);
		assert.equal(patchesBody.patches.some((patch) => patch.selector === "#root" && /<mermaid-diagram>/.test(patch.html)), true);
		assert.equal(patchesBody.patches.some((patch) => patch.selector === "#sidebar" && /data-event="checkpoint:approve_demo"/.test(patch.html)), true);
	} finally {
		await fake.emit("session_shutdown", {}, {});
	}
});

test("2.4 read_signals tool reads in-memory session state without steering", async () => {
	const fake = createFakePi();
	registerCanvasExtension(fake.pi);

	const readSignalsTool = fake.tools.find((tool) => tool.name === "read_signals");
	assert.ok(readSignalsTool?.execute);

	const result = await readSignalsTool.execute?.("id", undefined);
	assert.deepEqual((result as { details?: { signals?: Record<string, unknown> } }).details?.signals, {});
	assert.equal(fake.getSendUserMessageCalls(), 0);
});

test("2.6 wait_for_event tool wired to event runtime and returns timeout payload", async () => {
	const fake = createFakePi();
	registerCanvasExtension(fake.pi);

	const waitTool = fake.tools.find((tool) => tool.name === "wait_for_event");
	assert.ok(waitTool?.execute);

	const result = await waitTool.execute?.("id", { name: "approve", timeoutMs: 5 });
	assert.deepEqual((result as { details?: unknown }).details, { timeout: true });
	assert.equal(fake.getSendUserMessageCalls(), 0);
});

test("4.4 render tool wired to render runtime and returns queued patch payload", async () => {
	const fake = createFakePi();
	registerCanvasExtension(fake.pi);

	const renderTool = fake.tools.find((tool) => tool.name === "render");
	assert.ok(renderTool?.execute);

	const result = await renderTool.execute?.("id", {
		selector: "#status",
		html: "<p>hello</p>",
		mode: "append",
	});

	const details = (result as { details?: { ok?: boolean; patches?: Array<{ selector: string; mode: string; html: string }> } }).details;
	assert.equal(details?.ok, true);
	assert.deepEqual(
		details?.patches?.map((patch) => ({ selector: patch.selector, mode: patch.mode, html: patch.html })),
		[{ selector: "#status", mode: "append", html: "<p>hello</p>" }],
	);
	assert.equal(fake.getSendUserMessageCalls(), 0);
});

test("6.1/6.2 /canvas starts server if needed, prints URL, opens browser first time only", async () => {
	const fake = createFakePi();
	const events: Array<{ message: string; level?: string }> = [];
	let startServerCalls = 0;
	let openBrowserCalls = 0;

	registerCanvasExtension(fake.pi, {
		async startServer() {
			startServerCalls += 1;
			return {
				host: "127.0.0.1",
				port: 43210,
				baseUrl: "http://127.0.0.1:43210",
				url: "http://127.0.0.1:43210/?token=test-token",
				stop: async () => {},
			};
		},
		async openBrowser(url: string) {
			openBrowserCalls += 1;
			events.push({ message: `open:${url}` });
		},
	});

	const canvas = fake.getCommand("canvas");
	assert.ok(canvas?.handler);

	const result = await canvas.handler?.([], {
		ui: {
			notify(message: string, level?: string) {
				events.push({ message, level });
			},
		},
	});

	assert.equal(startServerCalls, 1);
	assert.equal(openBrowserCalls, 1);
	assert.deepEqual(result, {
		ok: true,
		url: "http://127.0.0.1:43210/?token=test-token",
		reused: false,
	});
	assert.deepEqual(events, [
		{ message: "Canvas URL: http://127.0.0.1:43210/?token=test-token", level: "info" },
		{
			message:
				"Canvas workflow: use render(selector, html, mode), read_signals(), wait_for_event(). Canvas temporary; summarize important feedback in chat.",
			level: "info",
		},
		{ message: "open:http://127.0.0.1:43210/?token=test-token" },
	]);
});

test("6.3/6.4 second /canvas call reuses same server url and does not reopen browser", async () => {
	const fake = createFakePi();
	let startServerCalls = 0;
	let openBrowserCalls = 0;
	const messages: string[] = [];

	registerCanvasExtension(fake.pi, {
		async startServer() {
			startServerCalls += 1;
			return {
				host: "127.0.0.1",
				port: 48123,
				baseUrl: "http://127.0.0.1:48123",
				url: "http://127.0.0.1:48123/?token=token-1",
				stop: async () => {},
			};
		},
		async openBrowser() {
			openBrowserCalls += 1;
		},
	});

	const canvas = fake.getCommand("canvas");
	assert.ok(canvas?.handler);

	const first = await canvas.handler?.([], {
		ui: { writeLine(line: string) { messages.push(line); } },
	});
	const second = await canvas.handler?.([], {
		ui: { writeLine(line: string) { messages.push(line); } },
	});

	assert.equal(startServerCalls, 1);
	assert.equal(openBrowserCalls, 1);
	assert.deepEqual(first, {
		ok: true,
		url: "http://127.0.0.1:48123/?token=token-1",
		reused: false,
	});
	assert.deepEqual(second, {
		ok: true,
		url: "http://127.0.0.1:48123/?token=token-1",
		reused: true,
	});
	assert.deepEqual(messages, [
		"Canvas URL: http://127.0.0.1:48123/?token=token-1",
		"Canvas workflow: use render(selector, html, mode), read_signals(), wait_for_event(). Canvas temporary; summarize important feedback in chat.",
		"Canvas URL: http://127.0.0.1:48123/?token=token-1",
		"Canvas workflow: use render(selector, html, mode), read_signals(), wait_for_event(). Canvas temporary; summarize important feedback in chat.",
	]);
});

test("6.11 browser-open failure warns and allows retry on later /canvas", async () => {
	const fake = createFakePi();
	const notices: Array<{ message: string; level?: string }> = [];
	let startServerCalls = 0;
	let openBrowserCalls = 0;

	registerCanvasExtension(fake.pi, {
		async startServer() {
			startServerCalls += 1;
			return {
				host: "127.0.0.1",
				port: 49221,
				baseUrl: "http://127.0.0.1:49221",
				url: "http://127.0.0.1:49221/?token=retry",
				stop: async () => {},
			};
		},
		async openBrowser() {
			openBrowserCalls += 1;
			if (openBrowserCalls === 1) throw new Error("open failed");
		},
	});

	const canvas = fake.getCommand("canvas");
	assert.ok(canvas?.handler);

	const first = await canvas.handler?.([], {
		ui: {
			notify(message: string, level?: string) {
				notices.push({ message, level });
			},
		},
	});
	const second = await canvas.handler?.([], {
		ui: {
			notify(message: string, level?: string) {
				notices.push({ message, level });
			},
		},
	});

	assert.deepEqual(first, { ok: true, url: "http://127.0.0.1:49221/?token=retry", reused: false });
	assert.deepEqual(second, { ok: true, url: "http://127.0.0.1:49221/?token=retry", reused: true });
	assert.equal(startServerCalls, 1);
	assert.equal(openBrowserCalls, 2);

	const warning = notices.find((entry) => entry.message.startsWith("Canvas browser open failed."));
	assert.ok(warning);
	assert.equal(warning?.level, "error");
	assert.match(warning?.message ?? "", /open failed/);
});

test("6.9/6.10 /canvas prints workflow guidance after url as fallback prompt injection", async () => {
	const fake = createFakePi();
	const messages: string[] = [];

	registerCanvasExtension(fake.pi, {
		async startServer() {
			return {
				host: "127.0.0.1",
				port: 49111,
				baseUrl: "http://127.0.0.1:49111",
				url: "http://127.0.0.1:49111/?token=guide",
				stop: async () => {},
			};
		},
	});

	const canvas = fake.getCommand("canvas");
	assert.ok(canvas?.handler);

	await canvas.handler?.([], {
		ui: { writeLine(line: string) { messages.push(line); } },
	});

	assert.equal(messages.length >= 2, true);
	assert.equal(messages[0], "Canvas URL: http://127.0.0.1:49111/?token=guide");
	assert.match(messages[1] ?? "", /Canvas workflow:/);
	assert.match(messages[1] ?? "", /render\(selector, html, mode\)/);
	assert.match(messages[1] ?? "", /read_signals\(\)/);
	assert.match(messages[1] ?? "", /wait_for_event\(\)/);
});

test("6.11 startServer failure returns {ok:false,error} and reports UI error without throw", async () => {
	const fake = createFakePi();
	const notices: Array<{ message: string; level?: string }> = [];

	registerCanvasExtension(fake.pi, {
		async startServer() {
			throw new Error("port busy");
		},
	});

	const canvas = fake.getCommand("canvas");
	assert.ok(canvas?.handler);

	const result = await canvas.handler?.([], {
		ui: {
			notify(message: string, level?: string) {
				notices.push({ message, level });
			},
		},
	});

	assert.deepEqual(result, { ok: false, error: "port busy" });
	assert.deepEqual(notices, [{ message: "Canvas failed to start: port busy", level: "error" }]);
});

test("6.5/6.6 session_shutdown stops server and resets canvas lifecycle", async () => {
	const fake = createFakePi();
	let startServerCalls = 0;
	let stopCalls = 0;
	let openBrowserCalls = 0;

	registerCanvasExtension(fake.pi, {
		async startServer() {
			startServerCalls += 1;
			return {
				host: "127.0.0.1",
				port: 49001,
				baseUrl: "http://127.0.0.1:49001",
				url: "http://127.0.0.1:49001/?token=shutdown",
				stop: async () => {
					stopCalls += 1;
				},
			};
		},
		async openBrowser() {
			openBrowserCalls += 1;
		},
	});

	const canvas = fake.getCommand("canvas");
	assert.ok(canvas?.handler);

	await canvas.handler?.([], { ui: {} });
	assert.equal(startServerCalls, 1);
	assert.equal(stopCalls, 0);

	await fake.emit("session_shutdown", {}, {});
	assert.equal(stopCalls, 1);

	await canvas.handler?.([], { ui: {} });
	assert.equal(startServerCalls, 2);
	assert.equal(openBrowserCalls, 2);
});

test("6.7/6.8 explicit attention + checkpoint send concise transcript messages; quiet sync sends nothing", async () => {
	const fake = createFakePi();
	let capturedOptions: CanvasServerOptions | undefined;

	registerCanvasExtension(fake.pi, {
		isAgentActive: () => true,
		async startServer(_session, options) {
			capturedOptions = options;
			return {
				host: "127.0.0.1",
				port: 49002,
				baseUrl: "http://127.0.0.1:49002",
				url: "http://127.0.0.1:49002/?token=events",
				stop: async () => {},
			};
		},
	});

	const canvas = fake.getCommand("canvas");
	assert.ok(canvas?.handler);
	await canvas.handler?.([], { ui: {} });

	assert.ok(capturedOptions?.attentionPolicy);
	assert.equal(fake.getSendUserMessageCalls(), 0);

	await pushAttentionEvent(
		createCanvasSession({ token: "attention" }),
		{ name: "revise_scope", payload: { source: "button" } },
		capturedOptions?.attentionPolicy,
	);

	const checkpointEvent = {
		name: "approve_scope",
		payload: { source: "submit" },
		signals: { "feedback.global": "ok" },
		timestamp: "2026-01-01T00:00:00.000Z",
	};
	const checkpointSummary = capturedOptions?.formatCheckpointSummary?.(checkpointEvent) ?? "";
	await capturedOptions?.onCheckpoint?.(checkpointSummary, checkpointEvent);

	assert.deepEqual(fake.sendUserMessages, [
		{
			message: "Canvas attention: revise scope (button)",
			options: { deliverAs: "steer" },
		},
		{
			message: "Canvas checkpoint: approve scope (submit)",
			options: undefined,
		},
	]);
});

test("8.5/8.6 /canvas smoke: command starts live server, serves shell, then restarts after shutdown", async () => {
	const fake = createFakePi();
	const lines: string[] = [];
	registerCanvasExtension(fake.pi);

	const canvas = fake.getCommand("canvas");
	assert.ok(canvas?.handler);

	const first = (await canvas.handler?.([], {
		ui: { writeLine(line: string) { lines.push(line); } },
	})) as { ok: boolean; url?: string; reused?: boolean };
	assert.equal(first.ok, true);
	assert.equal(first.reused, false);
	assert.equal(typeof first.url, "string");

	const url = first.url!;
	const live = await fetch(url);
	assert.equal(live.status, 200);
	const html = await live.text();
	assert.match(html, /id="status"/);
	assert.match(html, /id="root"/);
	assert.match(html, /id="sidebar"/);

	const baseUrl = url.replace(/\?.*$/, "");
	const blocked = await fetch(baseUrl);
	assert.equal(blocked.status, 401);

	await fake.emit("session_shutdown", {}, {});

	const second = (await canvas.handler?.([], {
		ui: { writeLine(line: string) { lines.push(line); } },
	})) as { ok: boolean; url?: string; reused?: boolean };
	assert.equal(second.ok, true);
	assert.equal(second.reused, false);
	assert.equal(typeof second.url, "string");

	const secondLive = await fetch(second.url!);
	assert.equal(secondLive.status, 200);

	await fake.emit("session_shutdown", {}, {});
});
