import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ControlEvent, Usage } from "../../src/shared/types.ts";
import { runChildAgent, type RunPreparedChildResult } from "../../src/runs/shared/child-agent-run.ts";

function usage(input = 0, output = 0): Usage {
	return { input, output, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 };
}

function baseInput() {
	return {
		agent: "worker",
		task: "Summarize this repo",
		runId: "run-1",
		prepareRequest: {
			context: {
				cwd: process.cwd(),
				sessionEnabled: false,
				inheritProjectContext: true,
				inheritSkills: true,
			},
			capabilities: {},
		},
	};
}

test("5.1/5.2 runChildAgent prepares args/env, runs once, classifies/finalizes, cleans temp resources", async () => {
	let calls = 0;
	let tempDir: string | undefined;
	let tempExistsDuringRun = false;
	const result = await runChildAgent(
		{
			...baseInput(),
			task: "x".repeat(9000),
		},
		{
			runPreparedChild: async ({ prepared }) => {
				calls += 1;
				tempDir = prepared.tempDir;
				tempExistsDuringRun = Boolean(tempDir && fs.existsSync(tempDir));
				assert.ok(prepared.args.includes("--mode"));
				assert.equal(prepared.env.PI_SUBAGENT_CHILD, "1");
				return {
					exitCode: 0,
					messages: [],
					usage: usage(10, 4),
					model: prepared.model,
					rawOutput: "done",
				};
			},
		},
	);

	assert.equal(calls, 1);
	assert.equal(result.exitCode, 0);
	assert.equal(result.error, undefined);
	assert.equal(result.finalOutput, "done");
	assert.equal(result.fullOutput, "done");
	assert.deepEqual(result.usage, usage(10, 4));
	assert.equal(tempExistsDuringRun, true);
	assert.ok(tempDir);
	assert.equal(fs.existsSync(tempDir!), false);
});

test("5.3/5.4 retryable model failure falls back, notes attempt, returns successful model", async () => {
	const seenModels: Array<string | undefined> = [];
	let runCount = 0;
	const result = await runChildAgent(
		{
			...baseInput(),
			modelCandidates: ["model-a", "model-b"],
			defaultModel: "model-a",
		},
		{
			runPreparedChild: async ({ prepared }): Promise<RunPreparedChildResult> => {
				seenModels.push(prepared.model);
				runCount += 1;
				if (runCount === 1) {
					return {
						exitCode: 1,
						messages: [],
						usage: usage(3, 1),
						error: "rate limit reached",
						rawOutput: "first failed",
					};
				}
				return {
					exitCode: 0,
					messages: [],
					usage: usage(5, 2),
					model: prepared.model,
					rawOutput: "second worked",
				};
			},
		},
	);

	assert.equal(runCount, 2);
	assert.deepEqual(seenModels, ["model-a", "model-b"]);
	assert.equal(result.exitCode, 0);
	assert.equal(result.model, "model-b");
	assert.equal(result.attemptNotes.length, 1);
	assert.match(result.attemptNotes[0] ?? "", /model-a failed/i);
	assert.match(result.finalOutput, /^\[fallback\]/);
	assert.deepEqual(result.attemptedModels, ["model-a", "model-b"]);
	assert.equal(result.modelAttempts?.length, 2);
});

test("5.5/5.6 non-retryable failure stops without trying later models", async () => {
	let runCount = 0;
	const result = await runChildAgent(
		{
			...baseInput(),
			modelCandidates: ["model-a", "model-b", "model-c"],
		},
		{
			runPreparedChild: async () => {
				runCount += 1;
				return {
					exitCode: 1,
					messages: [],
					usage: usage(2, 0),
					error: "validation failed",
					rawOutput: "bad",
				};
			},
		},
	);

	assert.equal(runCount, 1);
	assert.equal(result.exitCode, 1);
	assert.deepEqual(result.attemptedModels, ["model-a"]);
	assert.equal(result.modelAttempts?.length, 1);
	assert.equal(result.attemptNotes.length, 0);
});

test("5.7/5.8 artifacts record input before run and result after run", async () => {
	const callOrder: string[] = [];
	let recordedTask: string | undefined;
	let recordedResult: Record<string, unknown> | undefined;
	await runChildAgent(
		{
			...baseInput(),
			task: "Summarize module",
			artifactsDir: "/tmp/unused",
			artifactConfig: { enabled: true },
		},
		{
			createRunArtifacts: () => ({
				recordInput(task: string) {
					callOrder.push("input");
					recordedTask = task;
				},
				recordResult(input) {
					callOrder.push("result");
					recordedResult = input as unknown as Record<string, unknown>;
				},
			}),
			runPreparedChild: async () => {
				callOrder.push("run");
				return {
					exitCode: 0,
					messages: [],
					usage: usage(1, 1),
					rawOutput: "artifact output",
				};
			},
		},
	);

	assert.deepEqual(callOrder, ["input", "run", "result"]);
	assert.equal(recordedTask, "Summarize module");
	assert.equal(recordedResult?.task, "Summarize module");
	assert.equal(recordedResult?.output, "artifact output");
	assert.equal(recordedResult?.exitCode, 0);
});

test("5.9/5.10 callbacks receive runner progress/control events as immutable snapshots", async () => {
	const progressSeen: Array<Record<string, unknown>> = [];
	const controlSeen: ControlEvent[] = [];
	await runChildAgent(
		{
			...baseInput(),
			onProgress: (event) => {
				progressSeen.push(event);
				const nested = event.nested as { lines?: string[] } | undefined;
				nested?.lines?.push("mutated");
			},
			onControlEvent: (event) => {
				controlSeen.push(event);
				event.message = "mutated";
			},
		},
		{
			runPreparedChild: async ({ onProgress, onControlEvent }) => {
				const progressEvent = { type: "progress", nested: { lines: ["one"] } };
				onProgress?.(progressEvent);
				assert.deepEqual(progressEvent.nested.lines, ["one"]);

				const controlEvent: ControlEvent = {
					type: "needs_attention",
					from: undefined,
					to: "needs_attention",
					ts: Date.now(),
					agent: "worker",
					runId: "run-1",
					message: "needs check",
					reason: "idle",
				};
				onControlEvent?.(controlEvent);
				assert.equal(controlEvent.message, "needs check");
				return {
					exitCode: 0,
					messages: [],
					usage: usage(1, 0),
					rawOutput: "ok",
				};
			},
		},
	);

	assert.equal(progressSeen.length, 1);
	assert.equal((progressSeen[0]?.nested as { lines?: string[] })?.lines?.includes("mutated"), true);
	assert.equal(controlSeen.length, 1);
	assert.equal(controlSeen[0]?.message, "mutated");
});
