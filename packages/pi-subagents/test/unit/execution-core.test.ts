import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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
  buildPiArgs,
} from "../../src/runs/shared/pi-args.ts";
import { mapConcurrent } from "../../src/runs/shared/parallel-utils.ts";
import { resolveSingleOutputPath } from "../../src/runs/shared/single-output.ts";
import {
  applyAgentDefaultContext,
  expandTopLevelTaskCounts,
  normalizeRepeatedParallelCounts,
} from "../../src/runs/foreground/subagent-executor.ts";
import type { AgentConfig } from "../../src/agents/agents.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function agent(name: string, defaultContext?: "fresh" | "fork"): AgentConfig {
  return {
    name,
    description: `${name} agent`,
    systemPrompt: "test",
    mutationGuardPolicy: "auto",
    ...(defaultContext ? { defaultContext } : {}),
  } as AgentConfig;
}

test("3.3/3.4 default context becomes fork when selected agent defaults to fork", () => {
  assert.equal(
    applyAgentDefaultContext({ agent: "worker", task: "x" }, [agent("worker", "fork")]).context,
    "fork",
  );
  assert.equal(
    applyAgentDefaultContext({ tasks: [{ agent: "reviewer", task: "x" }] }, [agent("reviewer", "fork")]).context,
    "fork",
  );
  assert.equal(
    applyAgentDefaultContext({ chain: [{ agent: "planner", task: "x" }] }, [agent("planner", "fork")]).context,
    "fork",
  );
});

test("3.3/3.4 explicit context is preserved over agent default context", () => {
  assert.equal(
    applyAgentDefaultContext({ agent: "worker", task: "x", context: "fresh" }, [agent("worker", "fork")]).context,
    "fresh",
  );
  assert.equal(
    applyAgentDefaultContext({ agent: "worker", task: "x" }, [agent("worker", "fresh")]).context,
    undefined,
  );
});

test("3.5/3.6 single output path resolves relative to requested cwd", () => {
  const runtimeCwd = path.join(repoRoot, "runtime");
  const requestedCwd = path.join(repoRoot, "requested");
  assert.equal(
    resolveSingleOutputPath("out/report.md", runtimeCwd, requestedCwd),
    path.join(requestedCwd, "out/report.md"),
  );
  assert.equal(
    resolveSingleOutputPath("out/report.md", runtimeCwd),
    path.join(runtimeCwd, "out/report.md"),
  );
  assert.equal(resolveSingleOutputPath("/tmp/report.md", runtimeCwd, requestedCwd), "/tmp/report.md");
});

test("3.7/3.8 + 4.5/4.6 child args include subagent metadata env and structured supervisor target", () => {
  const { args, env } = buildPiArgs({
    baseArgs: ["--no-color"],
    task: "echo hi",
    sessionEnabled: false,
    inheritProjectContext: true,
    inheritSkills: false,
    intercomSessionName: "child-session",
    orchestratorIntercomTarget: "parent-session",
    supervisorIntercomTarget: {
      intercomSessionId: "parent-intercom-id",
      piSessionId: "parent-pi-id",
      alias: "parent-session",
      cwd: "/repo/parent",
    },
    runId: "run-123",
    childAgentName: "worker",
    childIndex: 2,
  });
  assert.ok(args.includes("Task: echo hi"));
  assert.deepEqual(args.slice(args.indexOf("--name"), args.indexOf("--name") + 2), ["--name", "child-session"]);
  assert.equal(env[SUBAGENT_CHILD_ENV], "1");
  assert.equal(env.PI_SUBAGENT_INTERCOM_SESSION_NAME, "child-session");
  assert.equal(env[SUBAGENT_ORCHESTRATOR_TARGET_ENV], "parent-session");
  assert.equal(env[SUBAGENT_SUPERVISOR_INTERCOM_SESSION_ID_ENV], "parent-intercom-id");
  assert.equal(env[SUBAGENT_SUPERVISOR_PI_SESSION_ID_ENV], "parent-pi-id");
  assert.equal(env[SUBAGENT_SUPERVISOR_ALIAS_ENV], "parent-session");
  assert.equal(env[SUBAGENT_SUPERVISOR_CWD_ENV], "/repo/parent");
  assert.equal(env[SUBAGENT_RUN_ID_ENV], "run-123");
  assert.equal(env[SUBAGENT_CHILD_AGENT_ENV], "worker");
  assert.equal(env[SUBAGENT_CHILD_INDEX_ENV], "2");
  assert.equal(env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT, "1");
  assert.equal(env.PI_SUBAGENT_INHERIT_SKILLS, "0");
});

test("4.3/4.4 mapConcurrent respects concurrency limit while preserving result order", async () => {
  const starts: number[] = [];
  const finishes: number[] = [];
  let active = 0;
  let maxActive = 0;
  const results = await mapConcurrent([30, 10, 1], 1, async (delay, index) => {
    starts.push(index);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
    finishes.push(index);
    return `result-${index}`;
  });
  assert.deepEqual(results, ["result-0", "result-1", "result-2"]);
  assert.deepEqual(starts, [0, 1, 2]);
  assert.deepEqual(finishes, [0, 1, 2]);
  assert.equal(maxActive, 1);
});

test("4.5/4.6 parallel task count expands into stable repeated tasks", () => {
  const expanded = expandTopLevelTaskCounts([
    { agent: "worker", task: "a", count: 2 },
    { agent: "reviewer", task: "b" },
  ]);
  assert.equal(expanded.error, undefined);
  assert.deepEqual(expanded.tasks, [
    { agent: "worker", task: "a" },
    { agent: "worker", task: "a" },
    { agent: "reviewer", task: "b" },
  ]);
});

test("4.5/4.6 invalid task count returns mode-specific error", () => {
  const result = normalizeRepeatedParallelCounts({ tasks: [{ agent: "worker", task: "x", count: 0 }] });
  assert.ok(result.error?.isError);
  assert.equal(result.error?.details?.mode, "parallel");
  assert.match(result.error?.content?.[0]?.text ?? "", /count must be an integer >= 1/);
});

test("4.7/4.8 output path helper writes/read target under per-task cwd", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-io-"));
  const taskCwd = path.join(temp, "task-a");
  fs.mkdirSync(taskCwd);
  const outputPath = resolveSingleOutputPath("nested/out.md", temp, taskCwd);
  assert.equal(outputPath, path.join(taskCwd, "nested/out.md"));
});
