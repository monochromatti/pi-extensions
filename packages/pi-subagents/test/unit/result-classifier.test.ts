import test from "node:test";
import assert from "node:assert/strict";
import type { Message } from "@earendil-works/pi-ai";
import type { Usage } from "../../src/shared/types.ts";
import { classifyChildRunResult } from "../../src/runs/shared/result-classifier.ts";

function usage(): Usage {
	return { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 };
}

test("1.1/1.2 clean success preserves model and usage with successful model attempt", () => {
	const runUsage = usage();
	const result = classifyChildRunResult({
		agent: "worker",
		task: "Summarize previous result",
		candidateModel: "anthropic/claude-sonnet-4",
		run: {
			exitCode: 0,
			messages: [],
			usage: runUsage,
			model: "anthropic/claude-sonnet-4",
		},
	});

	assert.equal(result.exitCode, 0);
	assert.equal(result.error, undefined);
	assert.equal(result.model, "anthropic/claude-sonnet-4");
	assert.deepEqual(result.usage, runUsage);
	assert.deepEqual(result.modelAttempt, {
		model: "anthropic/claude-sonnet-4",
		success: true,
		exitCode: 0,
		error: undefined,
		usage: runUsage,
	});
});

test("1.3/1.4 hidden tool error in messages becomes failure with normalized text", () => {
	const result = classifyChildRunResult({
		agent: "worker",
		task: "implement fix",
		run: {
			exitCode: 0,
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "working" }],
				},
				{
					role: "toolResult",
					toolName: "bash",
					isError: true,
					content: [{ type: "text", text: "exit code 7: kaboom" }],
				},
			] as Message[],
			usage: usage(),
		},
	});

	assert.equal(result.exitCode, 7);
	assert.equal(result.error, "bash failed (exit 7): exit code 7: kaboom");
	assert.equal(result.modelAttempt.success, false);
});

test("1.5/1.6 completion mutation guard fails implementation task with no observed mutation", () => {
	const result = classifyChildRunResult({
		agent: "worker",
		task: "Implement requested code fix in repository",
		run: {
			exitCode: 0,
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "Done." }],
				},
			] as Message[],
			usage: usage(),
		},
	});

	assert.equal(result.exitCode, 1);
	assert.equal(result.completionGuardTriggered, true);
	assert.match(result.error ?? "", /completed without making edits/i);
	assert.equal(result.modelAttempt.success, false);
});

test("1.7/1.8 run.error with zero exit fails; stderr used when non-zero has no explicit error", () => {
	const explicitError = classifyChildRunResult({
		agent: "worker",
		task: "implement fix",
		run: {
			exitCode: 0,
			error: "fatal",
			messages: [],
			usage: usage(),
		},
	});
	assert.equal(explicitError.exitCode, 1);
	assert.equal(explicitError.error, "fatal");

	const stderrFallback = classifyChildRunResult({
		agent: "worker",
		task: "implement fix",
		run: {
			exitCode: 9,
			stderr: "  stderr boom  ",
			messages: [],
			usage: usage(),
		},
	});
	assert.equal(stderrFallback.exitCode, 9);
	assert.equal(stderrFallback.error, "stderr boom");
});
