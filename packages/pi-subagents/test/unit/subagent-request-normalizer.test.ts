import test from "node:test";
import assert from "node:assert/strict";
import type { AgentConfig } from "../../src/agents/agents.ts";
import {
	applyDefaultContextToRunShape,
	normalizeSubagentRunShape,
	normalizeSubagentSurfaceRequest,
	validateSubagentRunRequest,
} from "../../src/runs/foreground/subagent-request-normalizer.ts";

function agent(name: string, defaultContext?: "fresh" | "fork"): AgentConfig {
	return { name, description: `${name} agent`, systemPrompt: "test", ...(defaultContext ? { defaultContext } : {}) } as AgentConfig;
}

function surfaceRun(params: Parameters<typeof normalizeSubagentSurfaceRequest>[0]["rawParams"]) {
	const surface = normalizeSubagentSurfaceRequest({ rawParams: params, runtimeCwd: "/repo" });
	assert.equal(surface.ok, true, surface.ok ? undefined : surface.result.content[0]?.text);
	assert.equal(surface.request.kind, "run-surface");
	return surface.request;
}

function shape(params: Parameters<typeof normalizeSubagentSurfaceRequest>[0]["rawParams"], opts: { depth?: number; asyncByDefault?: boolean; force?: boolean } = {}) {
	const runShape = normalizeSubagentRunShape({
		surface: surfaceRun(params),
		depth: opts.depth ?? 0,
		asyncByDefault: opts.asyncByDefault ?? false,
		forceTopLevelAsync: opts.force ?? false,
	});
	assert.equal(runShape.ok, true, runShape.ok ? undefined : runShape.result.content[0]?.text);
	return runShape.request;
}

test("surface normalizer resolves cwd and control requests without agents", () => {
	const status = normalizeSubagentSurfaceRequest({ rawParams: { action: "status", id: "abc", cwd: "sub" }, runtimeCwd: "/repo" });
	assert.equal(status.ok, true);
	assert.equal(status.request.kind, "status");
	assert.equal(status.request.requestedCwd, "/repo/sub");

	const interrupt = normalizeSubagentSurfaceRequest({ rawParams: { action: "interrupt", id: "abc" }, runtimeCwd: "/repo" });
	assert.equal(interrupt.ok, true);
	assert.equal(interrupt.request.kind, "interrupt");
	assert.equal(interrupt.request.targetRunId, "abc");

	const resume = normalizeSubagentSurfaceRequest({ rawParams: { action: "resume", id: "abc" }, runtimeCwd: "/repo" });
	assert.equal(resume.ok, true);
	assert.equal(resume.request.kind, "resume");
});

test("surface normalizer preserves schema-driven unknown action error", () => {
	const result = normalizeSubagentSurfaceRequest({ rawParams: { action: "bad" }, runtimeCwd: "/repo" });
	assert.equal(result.ok, false);
	assert.match(result.result.content[0]?.text ?? "", /action must be one of: status, interrupt, resume/);
});

test("run shape expands top-level counts before default context", () => {
	const runShape = shape({ tasks: [{ agent: "worker", task: "a", count: 2 }] });
	assert.equal(runShape.mode, "parallel");
	assert.deepEqual(runShape.params.tasks, [
		{ agent: "worker", task: "a" },
		{ agent: "worker", task: "a" },
	]);
	assert.equal(runShape.context, undefined);
});

test("run shape expands embedded parallel counts", () => {
	const runShape = shape({ chain: [{ parallel: [{ agent: "worker", task: "a", count: 2 }] }] });
	assert.equal(runShape.mode, "chain");
	assert.deepEqual(runShape.params.chain?.[0], { parallel: [{ agent: "worker", task: "a" }, { agent: "worker", task: "a" }] });
});

test("invalid count remains schema-driven before default context", () => {
	const surface = normalizeSubagentSurfaceRequest({ rawParams: { tasks: [{ agent: "worker", task: "a", count: 0 }] }, runtimeCwd: "/repo" });
	assert.equal(surface.ok, false);
	assert.equal(surface.result.details?.mode, "single");
	assert.equal(surface.result.details?.context, undefined);
	assert.match(surface.result.content[0]?.text ?? "", /tasks\[0\] count must be an integer greater than or equal to 1/);
});

test("default context applies after run shape succeeds", () => {
	const runShape = shape({ tasks: [{ agent: "worker", task: "a" }] });
	const withContext = applyDefaultContextToRunShape(runShape, [agent("worker", "fork")]);
	assert.equal(withContext.context, "fork");
	assert.equal(withContext.params.context, "fork");
});

test("force top-level async is captured in run shape", () => {
	assert.equal(shape({ agent: "worker" }, { depth: 0, force: true }).effectiveAsync, true);
	assert.equal(shape({ agent: "worker", async: false }, { depth: 0, force: true }).effectiveAsync, true);
	assert.equal(shape({ agent: "worker" }, { depth: 1, force: true }).effectiveAsync, false);
	assert.equal(shape({ agent: "worker" }, { asyncByDefault: true }).effectiveAsync, true);
});

test("validate run request returns discriminated single/parallel/chain requests", () => {
	const singleShape = applyDefaultContextToRunShape(shape({ agent: "worker" }), [agent("worker")]);
	const single = validateSubagentRunRequest({ shape: singleShape, executionAgents: [agent("worker")] });
	assert.equal(single.ok, true);
	assert.equal(single.request.mode, "single");
	assert.equal(single.request.task, "");

	const parallel = validateSubagentRunRequest({ shape: shape({ tasks: [{ agent: "worker", task: "a" }] }), executionAgents: [agent("worker")] });
	assert.equal(parallel.ok, true);
	assert.equal(parallel.request.mode, "parallel");

	const chain = validateSubagentRunRequest({ shape: shape({ chain: [{ agent: "worker", task: "a" }] }), executionAgents: [agent("worker")] });
	assert.equal(chain.ok, true);
	assert.equal(chain.request.mode, "chain");
});

test("validate run request preserves agent and chain errors", () => {
	const unknown = validateSubagentRunRequest({ shape: shape({ agent: "missing" }), executionAgents: [agent("worker")] });
	assert.equal(unknown.ok, false);
	assert.match(unknown.result.content[0]?.text ?? "", /Unknown agent: missing/);

	const missingFirstTask = validateSubagentRunRequest({ shape: shape({ chain: [{ agent: "worker" }] }), executionAgents: [agent("worker")] });
	assert.equal(missingFirstTask.ok, false);
	assert.match(missingFirstTask.result.content[0]?.text ?? "", /First step in chain must have a task/);
});
