import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listAsyncRuns } from "../../src/runs/background/async-status.ts";
import { type AsyncStatus } from "../../src/shared/types.ts";

function withAsyncStatus(status: AsyncStatus, fn: (root: string) => void): void {
	const root = mkdtempSync(path.join(tmpdir(), "pi-subagents-async-status-"));
	try {
		const runDir = path.join(root, status.runId);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(path.join(runDir, "status.json"), JSON.stringify(status));
		fn(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("async status treats only blocking supervisor calls as waiting decisions", () => {
	const base: AsyncStatus = {
		runId: "run-1",
		state: "running",
		mode: "single",
		startedAt: 1,
		lastUpdate: 2,
		currentStep: 0,
		currentTool: "contact_supervisor",
		steps: [{ agent: "worker", status: "running", startedAt: 1 }],
	};

	withAsyncStatus({ ...base, currentToolArgs: "reason=progress_update" }, (root) => {
		const [summary] = listAsyncRuns(root, { includeCompleted: true });
		assert.equal(summary?.state, "running");
	});

	withAsyncStatus({ ...base, currentToolArgs: "reason=need_decision" }, (root) => {
		const [summary] = listAsyncRuns(root, { includeCompleted: true });
		assert.equal(summary?.state, "waiting_decision");
	});
});
