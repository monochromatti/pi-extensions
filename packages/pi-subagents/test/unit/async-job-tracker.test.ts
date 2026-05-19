import assert from "node:assert/strict";
import test from "node:test";
import { isAsyncControlEventActionable } from "../../src/runs/background/async-job-tracker.ts";
import type { ControlEvent } from "../../src/shared/types.ts";

function event(overrides: Partial<ControlEvent> = {}): ControlEvent {
	return {
		type: "needs_attention",
		to: "needs_attention",
		ts: 1,
		runId: "run-1",
		agent: "reviewer",
		message: "reviewer needs attention",
		reason: "idle",
		...overrides,
	};
}

test("async control notices suppress stale attention events after terminal status", () => {
	assert.equal(isAsyncControlEventActionable({ status: "complete" }, event()), false);
	assert.equal(isAsyncControlEventActionable({ status: "failed" }, event({ type: "active_long_running", to: "active_long_running", reason: "active_long_running" })), false);
});

test("async control notices keep actionable running and completion-guard events", () => {
	assert.equal(isAsyncControlEventActionable({ status: "running" }, event()), true);
	assert.equal(isAsyncControlEventActionable({ status: "paused" }, event()), true);
	assert.equal(isAsyncControlEventActionable({ status: "complete" }, event({ reason: "completion_guard" })), true);
});
