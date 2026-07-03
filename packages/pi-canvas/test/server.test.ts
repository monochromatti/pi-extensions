import assert from "node:assert/strict";
import test from "node:test";
import { createCanvasSession } from "../src/session.ts";
import { ALLOWED_ASSET_ORIGINS } from "../src/assets.ts";
import { startCanvasServer } from "../src/server.ts";
import { waitForEvent } from "../src/events.ts";
import { renderToCanvas } from "../src/render.ts";

test("3.1 server binds loopback, session has random token, root requires auth", async (t) => {
	const session = createCanvasSession();
	assert.match(session.token, /^[a-f0-9]{32}$/);

	const runtime = await startCanvasServer(session);
	t.after(async () => {
		await runtime.stop();
	});

	assert.equal(runtime.host, "127.0.0.1");
	assert.equal(new URL(runtime.baseUrl).hostname, "127.0.0.1");
	assert.equal(session.server.port, runtime.port);
	assert.equal(session.server.url, runtime.url);

	const blocked = await fetch(`${runtime.baseUrl}/`);
	assert.equal(blocked.status, 401);

	const viaHeader = await fetch(`${runtime.baseUrl}/`, {
		headers: {
			"x-canvas-token": session.token,
		},
	});
	assert.equal(viaHeader.status, 200);

	const viaTokenizedUrl = await fetch(runtime.url);
	assert.equal(viaTokenizedUrl.status, 200);
});

test("3.3 shell includes stable slots + empty-state copy; 3.4 html route headers", async (t) => {
	const session = createCanvasSession();
	const runtime = await startCanvasServer(session);
	t.after(async () => {
		await runtime.stop();
	});

	const response = await fetch(runtime.url);
	assert.equal(response.status, 200);
	assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.equal(response.headers.get("x-content-type-options"), "nosniff");

	const html = await response.text();
	assert.match(html, /id="status"/);
	assert.match(html, /id="root"/);
	assert.match(html, /id="sidebar"/);
	assert.match(html, /<link[^>]+rel="stylesheet"[^>]+href="\/styles\.css"/);
	assert.match(html, /Canvas is temporary work surface next to Pi chat/);
});

test("3.5 static assets served with CSP matching allowlist", async (t) => {
	const session = createCanvasSession();
	const runtime = await startCanvasServer(session);
	t.after(async () => {
		await runtime.stop();
	});

	const asset = await fetch(`${runtime.baseUrl}/styles.css?token=${session.token}`);
	assert.equal(asset.status, 200);
	assert.match(asset.headers.get("content-type") ?? "", /^text\/css/);

	const csp = asset.headers.get("content-security-policy") ?? "";
	assert.ok(csp.length > 0);
	for (const origin of ALLOWED_ASSET_ORIGINS) {
		assert.match(csp, new RegExp(origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
});

test("3.7 /sync requires token and merges posted signals", async (t) => {
	const session = createCanvasSession();
	const runtime = await startCanvasServer(session);
	t.after(async () => {
		await runtime.stop();
	});

	const unauthorized = await fetch(`${runtime.baseUrl}/sync`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ signals: { "feedback.global": "draft" } }),
	});
	assert.equal(unauthorized.status, 401);

	const foreignOrigin = await fetch(`${runtime.baseUrl}/sync?token=${session.token}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin: "http://evil.example:9999",
		},
		body: JSON.stringify({ signals: { "feedback.global": "bad" } }),
	});
	assert.equal(foreignOrigin.status, 403);
	assert.deepEqual(session.signals, {});

	const first = await fetch(`${runtime.baseUrl}/sync?token=${session.token}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ signals: { "feedback.global": "draft", "choice.scope": "A" } }),
	});
	assert.equal(first.status, 200);
	assert.deepEqual(await first.json(), { ok: true });
	assert.deepEqual(session.signals, { "feedback.global": "draft", "choice.scope": "A" });

	const second = await fetch(`${runtime.baseUrl}/sync?token=${session.token}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ signals: { "feedback.global": "revised" } }),
	});
	assert.equal(second.status, 200);
	assert.deepEqual(session.signals, { "feedback.global": "revised", "choice.scope": "A" });
});

test("3.9 /event/checkpoint/:name requires token/origin and resolves waiter with payload+signals", async (t) => {
	const session = createCanvasSession();
	session.signals = { "feedback.global": "draft" };
	const runtime = await startCanvasServer(session);
	t.after(async () => {
		await runtime.stop();
	});

	const pending = waitForEvent(session, { name: "approve", timeoutMs: 500 });

	const unauthorized = await fetch(`${runtime.baseUrl}/event/checkpoint/approve`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ payload: { source: "button" }, signals: { "choice.scope": "A" } }),
	});
	assert.equal(unauthorized.status, 401);

	const foreignOrigin = await fetch(`${runtime.baseUrl}/event/checkpoint/approve?token=${session.token}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin: "http://evil.example:9999",
		},
		body: JSON.stringify({ payload: { source: "button" }, signals: { "choice.scope": "A" } }),
	});
	assert.equal(foreignOrigin.status, 403);

	const response = await fetch(`${runtime.baseUrl}/event/checkpoint/approve?token=${session.token}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ payload: { source: "button" }, signals: { "choice.scope": "A" } }),
	});
	assert.equal(response.status, 200);
	const body = (await response.json()) as { ok: boolean; event?: { name: string } };
	assert.equal(body.ok, true);
	assert.equal(body.event?.name, "approve");

	const resolved = await pending;
	assert.equal("timeout" in resolved, false);
	if ("timeout" in resolved) return;
	assert.equal(resolved.name, "approve");
	assert.deepEqual(resolved.payload, { source: "button" });
	assert.deepEqual(resolved.signals, { "feedback.global": "draft", "choice.scope": "A" });
	assert.match(resolved.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test("4.2 patch stream endpoint returns queued patches for browser runtime", async (t) => {
	const session = createCanvasSession();
	const runtime = await startCanvasServer(session);
	t.after(async () => {
		await runtime.stop();
	});

	const unauthorized = await fetch(`${runtime.baseUrl}/patches`);
	assert.equal(unauthorized.status, 401);

	renderToCanvas(session, { selector: "#status", html: "<p>ready</p>", mode: "inner" });
	renderToCanvas(session, { selector: "#status", html: "<p>append</p>", mode: "append" });

	const response = await fetch(`${runtime.baseUrl}/patches?token=${session.token}`);
	assert.equal(response.status, 200);
	assert.match(response.headers.get("content-type") ?? "", /^application\/json/);

	const body = (await response.json()) as {
		ok: boolean;
		patches: Array<{ selector: string; mode: string; html: string; id: number }>;
	};
	assert.equal(body.ok, true);
	assert.equal(body.patches.length, 2);
	assert.deepEqual(
		body.patches.map((patch) => ({ selector: patch.selector, mode: patch.mode, html: patch.html })),
		[
			{ selector: "#status", mode: "inner", html: "<p>ready</p>" },
			{ selector: "#status", mode: "append", html: "<p>append</p>" },
		],
	);

	const afterFirst = await fetch(`${runtime.baseUrl}/patches?token=${session.token}&after=${body.patches[0]!.id}`);
	assert.equal(afterFirst.status, 200);
	const afterBody = (await afterFirst.json()) as { patches: Array<{ mode: string; html: string }> };
	assert.deepEqual(afterBody.patches.map((patch) => ({ mode: patch.mode, html: patch.html })), [{ mode: "append", html: "<p>append</p>" }]);
});

test("3.11 /event/attention/:name calls callback and does not resolve checkpoint waiter", async (t) => {
	const session = createCanvasSession();
	session.signals = { "feedback.global": "draft" };
	const attentionCalls: Array<{ summary: string; options?: { deliverAs?: "steer" }; name?: string }> = [];
	const runtime = await startCanvasServer(session, {
		attentionPolicy: {
			isAgentActive: () => true,
			onAttention(summary, options, event) {
				attentionCalls.push({ summary, options, name: event?.name });
			},
		},
	});
	t.after(async () => {
		await runtime.stop();
	});

	const checkpointWaiter = waitForEvent(session, { name: "approve", timeoutMs: 20 });

	const unauthorized = await fetch(`${runtime.baseUrl}/event/attention/approve`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ payload: { source: "attention-button" }, signals: { "choice.scope": "B" } }),
	});
	assert.equal(unauthorized.status, 401);

	const foreignOrigin = await fetch(`${runtime.baseUrl}/event/attention/approve?token=${session.token}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			origin: "http://evil.example:9999",
		},
		body: JSON.stringify({ payload: { source: "attention-button" }, signals: { "choice.scope": "B" } }),
	});
	assert.equal(foreignOrigin.status, 403);

	const response = await fetch(`${runtime.baseUrl}/event/attention/approve?token=${session.token}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ payload: { source: "attention-button" }, signals: { "choice.scope": "B" } }),
	});
	assert.equal(response.status, 200);

	assert.deepEqual(attentionCalls, [
		{
			summary: "Canvas attention event: approve",
			options: { deliverAs: "steer" },
			name: "approve",
		},
	]);

	const checkpointResult = await checkpointWaiter;
	assert.deepEqual(checkpointResult, { timeout: true });
});

test("4.5 /stream requires token and delivers backlog + live patches as SSE", async (t) => {
	const session = createCanvasSession();
	const runtime = await startCanvasServer(session);
	t.after(async () => {
		await runtime.stop();
	});

	const unauthorized = await fetch(`${runtime.baseUrl}/stream`);
	assert.equal(unauthorized.status, 401);

	renderToCanvas(session, { selector: "#status", html: "<p>backlog</p>", mode: "inner" });

	const controller = new AbortController();
	t.after(() => controller.abort());
	const response = await fetch(`${runtime.baseUrl}/stream?token=${session.token}`, {
		signal: controller.signal,
	});
	assert.equal(response.status, 200);
	assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
	assert.ok(response.body);

	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const readEvents = async (expectedCount: number): Promise<Array<{ id: number; selector: string; html: string }>> => {
		const events: Array<{ id: number; selector: string; html: string }> = [];
		while (events.length < expectedCount) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let boundary = buffer.indexOf("\n\n");
			while (boundary >= 0) {
				const frame = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				boundary = buffer.indexOf("\n\n");
				const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
				if (!frame.includes("event: patch") || !dataLine) continue;
				events.push(JSON.parse(dataLine.slice("data: ".length)) as { id: number; selector: string; html: string });
			}
		}
		return events;
	};

	const backlog = await readEvents(1);
	assert.equal(backlog.length, 1);
	assert.deepEqual(
		{ selector: backlog[0]!.selector, html: backlog[0]!.html },
		{ selector: "#status", html: "<p>backlog</p>" },
	);

	renderToCanvas(session, { selector: "#status", html: "<p>live</p>", mode: "append" });
	const live = await readEvents(1);
	assert.equal(live.length, 1);
	assert.deepEqual({ selector: live[0]!.selector, html: live[0]!.html }, { selector: "#status", html: "<p>live</p>" });
	assert.equal(live[0]!.id > backlog[0]!.id, true);
});

test("3.10 checkpoint consumed by a waiter does not invoke onCheckpoint; unconsumed does", async (t) => {
	const session = createCanvasSession();
	const checkpointSummaries: string[] = [];
	const runtime = await startCanvasServer(session, {
		onCheckpoint: (summary) => {
			checkpointSummaries.push(summary);
		},
	});
	t.after(async () => {
		await runtime.stop();
	});

	const pending = waitForEvent(session, { name: "approve", timeoutMs: 1_000 });
	const consumed = await fetch(`${runtime.baseUrl}/event/checkpoint/approve?token=${session.token}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ payload: { source: "button" } }),
	});
	assert.equal(consumed.status, 200);
	const resolved = await pending;
	assert.equal("timeout" in resolved, false);
	assert.deepEqual(checkpointSummaries, []);

	const unconsumed = await fetch(`${runtime.baseUrl}/event/checkpoint/approve_later?token=${session.token}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ payload: { source: "button" } }),
	});
	assert.equal(unconsumed.status, 200);
	assert.deepEqual(checkpointSummaries, ["Canvas checkpoint: approve_later"]);
	assert.equal(session.eventQueue.length, 1);
});
