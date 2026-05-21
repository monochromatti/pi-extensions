import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
import { createTempDir, removeTempDir } from "../support/helpers.ts";

function createEventBus() {
	const listeners = new Map<string, Set<(payload: unknown) => void>>();
	const emitted: Array<{ channel: string; payload: Record<string, unknown> }> = [];
	return {
		emitted,
		on(channel: string, handler: (payload: unknown) => void) {
			const set = listeners.get(channel) ?? new Set<(payload: unknown) => void>();
			set.add(handler);
			listeners.set(channel, set);
			return () => set.delete(handler);
		},
		emit(channel: string, payload: unknown) {
			emitted.push({ channel, payload: payload as Record<string, unknown> });
			if (channel === "subagent:result-intercom") {
				const requestId = (payload as { requestId?: string }).requestId;
				for (const handler of listeners.get("subagent:result-intercom-delivery") ?? []) {
					handler({ requestId, delivered: true });
				}
			}
			for (const handler of listeners.get(channel) ?? []) handler(payload);
		},
	};
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.fail("timed out waiting for watcher relay payload");
}

test("5.7/5.8 async result watcher relay payload includes owner and structured target", async () => {
	const root = createTempDir("pi-subagents-result-watcher-");
	const resultsDir = path.join(root, "results");
	fs.mkdirSync(resultsDir, { recursive: true });
	const events = createEventBus();
	const state = {
		baseCwd: root,
		currentSessionId: "owner-session",
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};

	const runId = "async-grouped-run";
	const resultPath = path.join(resultsDir, `${runId}.json`);
	fs.writeFileSync(resultPath, JSON.stringify({
		id: runId,
		runId,
		mode: "parallel",
		state: "complete",
		summary: "worker finished",
		sessionId: "owner-session",
		ownerPiSessionId: "owner-session",
		intercomTarget: "parent-alias",
		intercomTargetDescriptor: {
			intercomSessionId: "parent-intercom-id",
			piSessionId: "owner-session",
			alias: "parent-alias",
		},
		results: [{
			agent: "worker",
			output: "done",
			success: true,
		}],
	}, null, 2), "utf-8");

	const watcher = createResultWatcher(
		{ events: events as never },
		state as never,
		resultsDir,
		10 * 60 * 1000,
	);

	try {
		watcher.primeExistingResults();
		await waitFor(() => events.emitted.some((entry) => entry.channel === "subagent:result-intercom"));
		const payload = events.emitted.find((entry) => entry.channel === "subagent:result-intercom")?.payload;
		assert.ok(payload, "result relay payload missing");
		assert.equal(payload?.ownerPiSessionId, "owner-session");
		assert.deepEqual(payload?.target, {
			intercomSessionId: "parent-intercom-id",
			piSessionId: "owner-session",
			alias: "parent-alias",
		});
		assert.equal(payload?.to, "parent-alias");
	} finally {
		watcher.stopResultWatcher();
		removeTempDir(root);
	}
});
