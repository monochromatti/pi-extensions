import test from "node:test";
import assert from "node:assert/strict";
import { createControlMonitor } from "../../src/runs/shared/control-monitor.ts";

test("4.1/4.2 no event before idle threshold, one needs_attention after threshold", () => {
	const monitor = createControlMonitor({
		config: {
			enabled: true,
			needsAttentionAfterMs: 1_000,
			activeNoticeAfterMs: 10_000,
			failedToolAttemptsBeforeAttention: 3,
			notifyOn: ["active_long_running", "needs_attention"],
			notifyChannels: ["event"],
		},
		runId: "run-1",
		agent: "worker",
		startedAt: 1_000,
	});

	const before = monitor.tick({ now: 1_900, turns: 0, tokens: 0, toolCount: 0 });
	assert.equal(before, undefined);

	const after = monitor.tick({ now: 2_100, turns: 0, tokens: 0, toolCount: 0 });
	assert.equal(after?.type, "needs_attention");
	assert.equal(after?.reason, "idle");
});

test("4.3/4.4 duplicate needs_attention ticks deduped", () => {
	const monitor = createControlMonitor({
		config: {
			enabled: true,
			needsAttentionAfterMs: 10,
			activeNoticeAfterMs: 10_000,
			failedToolAttemptsBeforeAttention: 3,
			notifyOn: ["active_long_running", "needs_attention"],
			notifyChannels: ["event"],
		},
		runId: "run-2",
		agent: "worker",
		startedAt: 1_000,
	});

	const first = monitor.tick({ now: 1_100, turns: 0, tokens: 0, toolCount: 0 });
	assert.equal(first?.type, "needs_attention");

	const second = monitor.tick({ now: 1_200, turns: 0, tokens: 0, toolCount: 0 });
	assert.equal(second, undefined);
});

test("4.5/4.6 long-running thresholds emit active_long_running before idle attention", () => {
	const baseConfig = {
		enabled: true,
		needsAttentionAfterMs: 10_000,
		activeNoticeAfterMs: 500,
		failedToolAttemptsBeforeAttention: 3,
		notifyOn: ["active_long_running", "needs_attention"] as const,
		notifyChannels: ["event"] as const,
	};

	const byTime = createControlMonitor({ config: baseConfig, runId: "run-t", agent: "worker", startedAt: 1_000 });
	const timeEvent = byTime.tick({ now: 1_700, turns: 0, tokens: 0, toolCount: 0 });
	assert.equal(timeEvent?.type, "active_long_running");
	assert.equal(timeEvent?.reason, "time_threshold");

	const byTurns = createControlMonitor({
		config: { ...baseConfig, activeNoticeAfterMs: 100_000, activeNoticeAfterTurns: 2 },
		runId: "run-turns",
		agent: "worker",
		startedAt: 1_000,
	});
	const turnsEvent = byTurns.tick({ now: 1_200, turns: 2, tokens: 0, toolCount: 0 });
	assert.equal(turnsEvent?.type, "active_long_running");
	assert.equal(turnsEvent?.reason, "turn_threshold");

	const byTokens = createControlMonitor({
		config: { ...baseConfig, activeNoticeAfterMs: 100_000, activeNoticeAfterTokens: 100 },
		runId: "run-tokens",
		agent: "worker",
		startedAt: 1_000,
	});
	const tokenEvent = byTokens.tick({ now: 1_200, turns: 0, tokens: 100, toolCount: 0 });
	assert.equal(tokenEvent?.type, "active_long_running");
	assert.equal(tokenEvent?.reason, "token_threshold");
});

test("4.7/4.8 mutating tool failure escalation emits needs_attention with summary", () => {
	const monitor = createControlMonitor({
		config: {
			enabled: true,
			needsAttentionAfterMs: 60_000,
			activeNoticeAfterMs: 120_000,
			failedToolAttemptsBeforeAttention: 2,
			notifyOn: ["active_long_running", "needs_attention"],
			notifyChannels: ["event"],
		},
		runId: "run-4",
		agent: "worker",
		startedAt: 1_000,
	});

	const first = monitor.recordMutatingToolResult({
		now: 1_500,
		tool: "edit",
		path: "src/file.ts",
		resultText: "error: no exact match",
		turns: 1,
		tokens: 10,
		toolCount: 1,
	});
	assert.equal(first, undefined);

	const second = monitor.recordMutatingToolResult({
		now: 1_700,
		tool: "edit",
		path: "src/file.ts",
		startedAt: 1_650,
		resultText: "failed applying edit",
		turns: 2,
		tokens: 20,
		toolCount: 2,
	});
	assert.equal(second?.type, "needs_attention");
	assert.equal(second?.reason, "tool_failures");
	assert.match(second?.recentFailureSummary ?? "", /edit\(src\/file.ts\): error: no exact match/);
	assert.match(second?.recentFailureSummary ?? "", /edit\(src\/file.ts\): failed applying edit/);
});
