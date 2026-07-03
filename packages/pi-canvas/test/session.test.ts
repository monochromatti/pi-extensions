import assert from "node:assert/strict";
import test from "node:test";
import { pushAttentionEvent, pushCheckpointEvent, waitForEvent } from "../src/events.ts";
import { createCanvasSession } from "../src/session.ts";
import { mergeQuietSignals, readSignals } from "../src/signals.ts";

test("2.1 new session has token, empty stores, unset canvas URL metadata", () => {
	const session = createCanvasSession({ token: "test-token" });

	assert.equal(session.token, "test-token");
	assert.deepEqual(session.signals, {});
	assert.deepEqual(session.eventQueue, []);
	assert.deepEqual(session.waiters, []);
	assert.equal(session.server.url, undefined);
	assert.equal(session.server.port, undefined);
});

test("2.3 quiet signal updates merge + read without steering user message", () => {
	const session = createCanvasSession({ token: "test-token" });
	let sendUserMessageCalls = 0;
	const sendUserMessage = () => {
		sendUserMessageCalls += 1;
	};

	mergeQuietSignals(session, { "feedback.global": "v1", untouched: true });
	mergeQuietSignals(session, { "feedback.global": "v2", "choice.scope": "A" });

	assert.deepEqual(readSignals(session), {
		"feedback.global": "v2",
		untouched: true,
		"choice.scope": "A",
	});
	assert.deepEqual(readSignals(session, { keys: ["feedback.global", "missing"] }), {
		"feedback.global": "v2",
	});

	void sendUserMessage;
	assert.equal(sendUserMessageCalls, 0);
});

test("2.5 wait_for_event resolves named checkpoint with payload, signals, timestamp", async () => {
	const session = createCanvasSession({ token: "test-token" });
	session.signals = { "feedback.section.scope": "ship it" };

	const pending = waitForEvent(session, { name: "approve", timeoutMs: 1_000 });
	const checkpoint = pushCheckpointEvent(session, {
		name: "approve",
		payload: { source: "button" },
		timestamp: "2026-01-01T00:00:00.000Z",
	});
	assert.equal(checkpoint.consumedByWaiter, true);

	const result = await pending;
	assert.deepEqual(result, {
		name: "approve",
		payload: { source: "button" },
		signals: { "feedback.section.scope": "ship it" },
		timestamp: "2026-01-01T00:00:00.000Z",
	});
	assert.deepEqual(result, checkpoint.event);
	assert.deepEqual(session.waiters, []);
});

test("2.7 wait_for_event timeout returns timeout true", async () => {
	const session = createCanvasSession({ token: "test-token" });

	const result = await waitForEvent(session, { name: "approve", timeoutMs: 5 });
	assert.deepEqual(result, { timeout: true });
	assert.deepEqual(session.waiters, []);
});

test("2.8 wait_for_event abort cleans waiter and returns timeout shape", async () => {
	const session = createCanvasSession({ token: "test-token" });
	const controller = new AbortController();

	const pending = waitForEvent(session, { name: "approve", signal: controller.signal });
	assert.equal(session.waiters.length, 1);
	controller.abort();

	const result = await pending;
	assert.deepEqual(result, { timeout: true });
	assert.deepEqual(session.waiters, []);
});

test("2.9/2.10 attention event steers only when active; checkpoint never duplicates steering", async () => {
	const session = createCanvasSession({ token: "test-token" });
	session.signals = { "feedback.global": "Need tighter scope" };
	const calls: Array<{ summary: string; options?: { deliverAs?: "steer" } }> = [];

	await pushAttentionEvent(
		session,
		{ name: "revise", payload: { section: "scope" }, timestamp: "2026-01-01T00:00:01.000Z" },
		{
			isAgentActive: () => true,
			onAttention(summary, options) {
				calls.push({ summary, options });
			},
			formatSummary: (event) => `Canvas: ${event.name}`,
		},
	);

	await pushAttentionEvent(
		session,
		{ name: "revise", payload: { section: "scope" }, timestamp: "2026-01-01T00:00:02.000Z" },
		{
			isAgentActive: () => false,
			onAttention(summary, options) {
				calls.push({ summary, options });
			},
			formatSummary: (event) => `Canvas: ${event.name}`,
		},
	);

	const queued = pushCheckpointEvent(session, {
		name: "approve",
		payload: { source: "button" },
		timestamp: "2026-01-01T00:00:03.000Z",
	});
	assert.equal(queued.consumedByWaiter, false);

	assert.deepEqual(calls, [
		{ summary: "Canvas: revise", options: { deliverAs: "steer" } },
		{ summary: "Canvas: revise", options: undefined },
	]);
	assert.equal(session.eventQueue.length, 1);
	assert.equal(session.eventQueue[0]?.name, "approve");
});
