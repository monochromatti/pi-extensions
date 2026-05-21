import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { prepareChildRun } from "../../src/runs/shared/child-run-preparation.ts";
import {
	SUBAGENT_CHILD_AGENT_ENV,
	SUBAGENT_CHILD_ENV,
	SUBAGENT_CHILD_INDEX_ENV,
	SUBAGENT_ORCHESTRATOR_TARGET_ENV,
	SUBAGENT_SUPERVISOR_ALIAS_ENV,
	SUBAGENT_SUPERVISOR_CWD_ENV,
	SUBAGENT_SUPERVISOR_INTERCOM_SESSION_ID_ENV,
	SUBAGENT_SUPERVISOR_PI_SESSION_ID_ENV,
	SUBAGENT_RUN_ID_ENV,
} from "../../src/runs/shared/pi-args.ts";

test("child-run preparation hides Pi args/env/depth setup", () => {
	const prepared = prepareChildRun({
		baseArgs: ["--mode", "json", "-p"],
		task: "inspect repo",
		identity: { runId: "run-1", agentName: "worker", childIndex: 2 },
		context: {
			sessionEnabled: false,
			inheritProjectContext: true,
			inheritSkills: false,
			maxSubagentDepth: 7,
		},
		capabilities: {
			model: "anthropic/claude-sonnet-4",
			thinking: "low",
			tools: ["read"],
			mcpDirectTools: [],
			systemPromptMode: "append",
			promptFileStem: "worker",
		},
		supervisor: {
			childIntercomTarget: "child-worker",
			orchestratorIntercomTarget: "supervisor",
			supervisorIntercomTarget: {
				intercomSessionId: "supervisor-intercom-id",
				piSessionId: "supervisor-pi-id",
				alias: "supervisor",
				cwd: "/repo/supervisor",
			},
		},
	});

	assert.equal(prepared.model, "anthropic/claude-sonnet-4:low");
	assert.ok(prepared.args.includes("--model"));
	assert.ok(prepared.args.includes("anthropic/claude-sonnet-4:low"));
	assert.equal(prepared.env[SUBAGENT_CHILD_ENV], "1");
	assert.equal(prepared.env[SUBAGENT_RUN_ID_ENV], "run-1");
	assert.equal(prepared.env[SUBAGENT_CHILD_AGENT_ENV], "worker");
	assert.equal(prepared.env[SUBAGENT_CHILD_INDEX_ENV], "2");
	assert.equal(prepared.env[SUBAGENT_ORCHESTRATOR_TARGET_ENV], "supervisor");
	assert.equal(prepared.env[SUBAGENT_SUPERVISOR_INTERCOM_SESSION_ID_ENV], "supervisor-intercom-id");
	assert.equal(prepared.env[SUBAGENT_SUPERVISOR_PI_SESSION_ID_ENV], "supervisor-pi-id");
	assert.equal(prepared.env[SUBAGENT_SUPERVISOR_ALIAS_ENV], "supervisor");
	assert.equal(prepared.env[SUBAGENT_SUPERVISOR_CWD_ENV], "/repo/supervisor");
	assert.equal(prepared.env.MCP_DIRECT_TOOLS, "__none__");
	assert.equal(prepared.spawnEnv.PI_SUBAGENT_MAX_DEPTH, "7");
	prepared.cleanup();
	prepared.cleanup();
});

test("child-run preparation owns long task temp file cleanup", () => {
	const prepared = prepareChildRun({
		baseArgs: ["--mode", "json", "-p"],
		task: "x".repeat(9000),
		identity: { agentName: "worker" },
		context: {
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: true,
		},
		capabilities: {},
	});

	assert.ok(prepared.tempDir);
	assert.ok(fs.existsSync(prepared.tempDir));
	assert.ok(prepared.args.some((arg) => arg.startsWith("@")));
	prepared.cleanup();
	assert.equal(fs.existsSync(prepared.tempDir), false);
});
