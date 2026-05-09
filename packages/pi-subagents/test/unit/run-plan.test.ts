import test from "node:test";
import assert from "node:assert/strict";
import type { AgentConfig } from "../../src/agents/agents.ts";
import { buildRunPlan } from "../../src/runs/plan/run-plan.ts";

function agent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name,
		description: `${name} agent`,
		systemPrompt: "test",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "project",
		filePath: `/agents/${name}.md`,
		...overrides,
	} as AgentConfig;
}

function baseInput(overrides: Partial<Parameters<typeof buildRunPlan>[0]> = {}): Parameters<typeof buildRunPlan>[0] {
	return {
		mode: "single",
		params: { agent: "worker", task: "run" },
		effectiveCwd: "/repo",
		agents: [agent("worker")],
		config: {},
		asyncByDefault: false,
		asyncAvailable: true,
		parentSessionFile: "/repo/.pi/sessions/root/session.jsonl",
		tempArtifactsDir: "/tmp/subagents",
		getSubagentSessionRoot: () => "/repo/.pi/sessions/root/subagents",
		expandTilde: (value) => value.replace("~", "/home/test"),
		runId: "run-1234",
		...overrides,
	};
}

test("6.1/6.2 single plan resolves cwd/run/session/artifact/control/depth/agent", () => {
	const previousMaxDepth = process.env.PI_SUBAGENT_MAX_DEPTH;
	delete process.env.PI_SUBAGENT_MAX_DEPTH;
	try {
		const worker = agent("worker", { output: "worker-out.md", model: "m-worker", maxSubagentDepth: 2, thinking: "high" });
		const plan = buildRunPlan(baseInput({
			params: {
				agent: "worker",
				task: "Implement feature",
				async: false,
				output: true,
				control: { enabled: false },
			},
			effectiveCwd: "/repo/pkg",
			agents: [worker],
			config: {
				defaultSessionDir: "~/sessions",
				maxSubagentDepth: 7,
				control: { enabled: true, needsAttentionAfterMs: 9999 },
			},
			sessionFileFromContext: () => "/fork/session.jsonl",
		}));

		assert.equal(plan.mode, "single");
		assert.equal(plan.runId, "run-1234");
		assert.equal(plan.effectiveCwd, "/repo/pkg");
		assert.equal(plan.session.root, "/home/test/sessions/run-1234");
		assert.equal(plan.session.fileForIndex(0), "/fork/session.jsonl");
		assert.equal(plan.artifactConfig.enabled, true);
		assert.equal(plan.artifactsDir, "/repo/.pi/sessions/root/subagent-artifacts");
		assert.equal(plan.controlConfig.enabled, false);
		assert.equal(plan.depth.current, 7);
		assert.equal(plan.depth.forAgent(worker), 2);
		assert.equal(plan.agent.name, "worker");
		assert.equal(plan.output, "worker-out.md");
		assert.equal(plan.outputMode, "inline");
		assert.equal(plan.model, "m-worker");
		assert.equal(plan.maxSubagentDepth, 2);
	} finally {
		if (previousMaxDepth === undefined) delete process.env.PI_SUBAGENT_MAX_DEPTH;
		else process.env.PI_SUBAGENT_MAX_DEPTH = previousMaxDepth;
	}
});

test("6.3/6.4 parallel plan expands counts, caps concurrency, resolves child settings", () => {
	const plan = buildRunPlan(baseInput({
		mode: "parallel",
		params: {
			tasks: [
				{ agent: "writer", task: "Draft", count: 2, output: true },
				{ agent: "reviewer", task: "review-only audit", progress: true, output: "review.md", outputMode: "file-only" },
			],
			concurrency: 10,
		},
		agents: [
			agent("writer", { output: "writer.md", model: "model-w", maxSubagentDepth: 4 }),
			agent("reviewer", { model: "model-r", maxSubagentDepth: 1 }),
		],
		config: { parallel: { concurrency: 4, maxTasks: 9 }, maxSubagentDepth: 6 },
	}));

	assert.equal(plan.mode, "parallel");
	assert.equal(plan.tasks.length, 3);
	assert.equal(plan.maxTasks, 9);
	assert.equal(plan.concurrency, 3);
	assert.equal(plan.children.length, 3);
	assert.equal(plan.children[0]?.sessionFile, "/repo/.pi/sessions/root/subagents/run-1234/run-0/session.jsonl");
	assert.equal(plan.children[0]?.behavior.output, "writer.md");
	assert.equal(plan.children[0]?.model, "model-w");
	assert.equal(plan.children[2]?.behavior.outputMode, "file-only");
	assert.equal(plan.children[2]?.behavior.progress, false);
	assert.equal(plan.children[2]?.maxSubagentDepth, 1);
});

test("6.5/6.6 chain plan resolves templates/defaults/read-only suppression/per-step agents", () => {
	const plan = buildRunPlan(baseInput({
		mode: "chain",
		params: {
			task: "Top task",
			skill: ["shared"],
			chain: [
				{ agent: "planner", progress: true },
				{
					parallel: [
						{ agent: "reviewer", task: "review-only {task}", progress: true, count: 2 },
						{ agent: "coder", task: "Implement {previous}", skill: false },
					],
					concurrency: 5,
				},
				{ agent: "finisher", task: "Finalize {previous}", output: "final.md" },
			],
		},
		agents: [
			agent("planner", { skills: ["plan"] }),
			agent("reviewer", { defaultProgress: true, skills: ["review"] }),
			agent("coder", { skills: ["code"] }),
			agent("finisher", { output: "default.md" }),
		],
		config: { parallel: { concurrency: 2 } },
	}));

	assert.equal(plan.mode, "chain");
	assert.deepEqual(plan.chainSkills, ["shared"]);
	assert.equal(plan.steps.length, 3);
	assert.equal(plan.steps[0]?.type, "sequential");
	if (plan.steps[0]?.type === "sequential") {
		assert.equal(plan.steps[0].taskTemplate, "Top task");
		assert.deepEqual(plan.steps[0].behavior.skills, ["plan", "shared"]);
	}
	assert.equal(plan.steps[1]?.type, "parallel");
	if (plan.steps[1]?.type === "parallel") {
		assert.equal(plan.steps[1].tasks.length, 3);
		assert.equal(plan.steps[1].concurrency, 3);
		assert.equal(plan.steps[1].tasks[0]?.behavior.progress, false);
		assert.equal(plan.steps[1].tasks[2]?.behavior.skills, false);
	}
	if (plan.steps[2]?.type === "sequential") {
		assert.equal(plan.steps[2].agent.name, "finisher");
		assert.equal(plan.steps[2].behavior.output, "final.md");
	}
});

test("6.7/6.8 async mode decision honors explicit/default/action/availability", () => {
	const explicitAsync = buildRunPlan(baseInput({
		params: { agent: "worker", task: "x", async: true },
		asyncByDefault: false,
		asyncAvailable: false,
	}));
	assert.equal(explicitAsync.asyncMode.requestedAsync, true);
	assert.equal(explicitAsync.asyncMode.effectiveAsync, true);
	assert.equal(explicitAsync.asyncMode.asyncLaunchAllowed, false);
	assert.equal(explicitAsync.asyncMode.reason, "explicit");

	const defaultAsync = buildRunPlan(baseInput({
		params: { agent: "worker", task: "x" },
		asyncByDefault: true,
		asyncAvailable: true,
	}));
	assert.equal(defaultAsync.asyncMode.requestedAsync, true);
	assert.equal(defaultAsync.asyncMode.reason, "config_default");

	const management = buildRunPlan(baseInput({
		params: { agent: "worker", task: "x", async: true, action: "status" },
		action: "status",
		asyncByDefault: true,
		asyncAvailable: true,
	}));
	assert.equal(management.asyncMode.requestedAsync, false);
	assert.equal(management.asyncMode.effectiveAsync, false);
	assert.equal(management.asyncMode.reason, "management_action");
});
