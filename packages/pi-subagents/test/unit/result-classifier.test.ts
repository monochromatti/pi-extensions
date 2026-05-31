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

test("1.7 oracle review of proposed implementation does not require mutations", () => {
	const result = classifyChildRunResult({
		agent: "oracle",
		task: "Review this proposed Nix flake dendritic refactor idea. Proposal: move modules/dev/lima-hosts.nix -> modules/virtualization/lima.nix and update import. Question: Is this good design? Any better namespace/file shape or risks?",
		run: {
			exitCode: 0,
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "Recommendation: keep public names unchanged." }],
				},
			] as Message[],
			usage: usage(),
		},
	});

	assert.equal(result.exitCode, 0);
	assert.equal(result.completionGuardTriggered, false);
	assert.equal(result.error, undefined);
	assert.equal(result.modelAttempt.success, true);
});

test("1.8 explicit mutation guard policy ignores implementation discussion unless edits are required", () => {
	const result = classifyChildRunResult({
		agent: "architect",
		task: "Create implementation plan to refactor module layout and update imports",
		mutationGuardPolicy: "explicit",
		run: {
			exitCode: 0,
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "Plan: 1. inspect files 2. edit imports." }],
				},
			] as Message[],
			usage: usage(),
		},
	});

	assert.equal(result.exitCode, 0);
	assert.equal(result.completionGuardTriggered, false);
	assert.equal(result.error, undefined);
	assert.equal(result.modelAttempt.success, true);
});

test("1.9 explicit mutation guard policy requires mutations for direct edit instructions", () => {
	const result = classifyChildRunResult({
		agent: "reviewer",
		task: "Review and apply fixes directly",
		mutationGuardPolicy: "explicit",
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

test("1.10 never mutation guard policy lets custom review agents discuss refactors", () => {
	const result = classifyChildRunResult({
		agent: "architect",
		task: "Review this proposed refactor and update plan",
		mutationGuardPolicy: "never",
		run: {
			exitCode: 0,
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "Recommendation: proceed." }],
				},
			] as Message[],
			usage: usage(),
		},
	});

	assert.equal(result.exitCode, 0);
	assert.equal(result.completionGuardTriggered, false);
	assert.equal(result.error, undefined);
	assert.equal(result.modelAttempt.success, true);
});

test("1.11 always mutation guard policy fails success without mutations", () => {
	const result = classifyChildRunResult({
		agent: "writer",
		task: "Summarize status",
		mutationGuardPolicy: "always",
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

test("1.12/1.13 run.error with zero exit fails; stderr used when non-zero has no explicit error", () => {
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
