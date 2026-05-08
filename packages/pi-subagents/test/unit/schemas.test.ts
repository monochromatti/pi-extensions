import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SubagentParams, validateSubagentParams } from "../../src/extension/schemas.ts";

const root = path.resolve(import.meta.dirname, "../..");

function assertValid(params: unknown): void {
  const result = validateSubagentParams(params);
  assert.equal(result.ok, true, result.error);
}

function assertInvalid(params: unknown, expected: RegExp): void {
  const result = validateSubagentParams(params);
  assert.equal(result.ok, false, "params should fail validation");
  assert.match(result.error ?? "", expected);
}

test("2.1/2.2 accepts reduced single mode", () => {
  assertValid({
    agent: "worker",
    task: "implement feature",
    context: "fork",
    cwd: "/tmp/project",
    async: true,
    output: "result.md",
    outputMode: "file-only",
    skill: ["pi-subagents"],
    model: "anthropic/claude-sonnet-4",
    thinking: "high",
  });
  assertValid({ agent: "planner" });
});

test("2.3/2.4 accepts reduced parallel mode", () => {
  assertValid({
    tasks: [
      { agent: "researcher", task: "research", reads: ["README.md"], output: "research.md", skill: "pi-subagents", model: "google/gemini-3-pro", thinking: "medium" },
      { agent: "reviewer", task: "review", count: 2, outputMode: "inline" },
    ],
    concurrency: 2,
    context: "fresh",
  });
});

test("2.5/2.6 accepts reduced chain mode with sequential and embedded parallel steps", () => {
  assertValid({
    task: "ship feature",
    chain: [
      { agent: "researcher", task: "Research {task}", output: "research.md" },
      {
        parallel: [
          { agent: "planner", task: "Plan from {previous}", outputMode: "inline" },
          { agent: "reviewer", task: "Review from {previous}", count: 1 },
        ],
        concurrency: 2,
        failFast: false,
      },
      { agent: "worker", task: "Implement from {previous}", skill: false, model: "anthropic/claude-sonnet-4", thinking: "low" },
    ],
    context: "fork",
  });
});

test("2.7/2.8 rejects removed fields, actions, and removed template variable", () => {
  assertInvalid({ agent: "worker", chainDir: "/tmp/chain" }, /chainDir is not supported/);
  assertInvalid({ tasks: [{ agent: "worker", task: "x" }], worktree: true }, /worktree mode is not supported/);
  assertInvalid({ chain: [{ agent: "worker" }], clarify: true }, /clarify TUI is not supported/);
  assertInvalid({ action: "create", config: {} }, /agent management actions are not supported/);
  assertInvalid({ chainName: "release", action: "get" }, /agent management actions are not supported/);
  assertInvalid({ agent: "worker", agentScope: "project" }, /agentScope is not supported/);
  assertInvalid({ agent: "worker", artifacts: false }, /artifacts is not a public option/);
  for (const action of ["list", "get", "create", "update", "delete", "doctor"]) {
    assertInvalid({ action }, /agent management actions are not supported/);
  }
  assertInvalid({ chain: [{ agent: "worker", task: "write to {chain_dir}" }] }, /template variable is not supported/);
  assertInvalid({ tasks: [{ agent: "worker", task: "read {chain_dir}" }] }, /template variable is not supported/);
});

test("2.7/2.8 rejects removed fields recursively anywhere in params", () => {
  assertInvalid({ chain: [{ parallel: [{ agent: "worker", task: "x" }], worktree: true }] }, /worktree mode is not supported/);
  assertInvalid({ chain: [{ agent: "worker", task: "x", chainDir: "/tmp/chain" }] }, /chainDir is not supported/);
  assertInvalid({ tasks: [{ agent: "worker", task: "x", clarify: true }] }, /clarify TUI is not supported/);
  assertInvalid({ chain: [{ parallel: [{ agent: "worker", task: "x", config: {} }] }] }, /agent management actions are not supported/);
  assertInvalid({ chain: [{ agent: "worker", task: "x", metadata: { chainName: "release" } }] }, /agent management actions are not supported/);
});

test("2.9/2.10 accepts control mode and rejects mixed or unknown modes", () => {
  assertValid({ action: "status", id: "abc", dir: "/tmp/run" });
  assertValid({ action: "interrupt", runId: "abc", index: 0 });
  assertValid({ action: "resume", id: "abc", message: "continue", index: 1 });

  assertInvalid({ action: "pause", id: "abc" }, /action must be one of/);
  assertInvalid({ action: "status", agent: "worker" }, /exactly one subagent mode/);
  assertInvalid({ agent: "worker", tasks: [{ agent: "reviewer", task: "review" }] }, /exactly one subagent mode/);
  assertInvalid({}, /exactly one subagent mode/);
});

test("2.10 validates counts, concurrency, and file-only output requirements", () => {
  assertInvalid({ tasks: [{ agent: "worker", task: "x", count: 0 }] }, /count must be/);
  assertInvalid({ tasks: [{ agent: "worker", task: "x" }], concurrency: 0 }, /concurrency must be/);
  assertInvalid({ chain: [{ parallel: [{ agent: "worker", task: "x" }], concurrency: 0 }] }, /concurrency must be/);
  assertInvalid({ agent: "worker", outputMode: "file-only" }, /does not configure an output file/);
  assertInvalid({ tasks: [{ agent: "worker", task: "x", outputMode: "file-only" }] }, /does not configure an output file/);
  assertInvalid({ chain: [{ agent: "worker", outputMode: "file-only" }] }, /does not configure an output file/);
});

test("2.11 schema and tool descriptions do not advertise removed features", () => {
  const schemaText = JSON.stringify(SubagentParams);
  const extensionSource = fs.readFileSync(path.join(root, "src/extension/index.ts"), "utf8");
  const forbidden = [
    "chain_dir",
    "chainDir",
    "worktree",
    "clarify",
    "/parallel-review",
    "/parallel-cleanup",
    "/parallel-research",
    "/parallel-context-build",
    "/parallel-handoff-plan",
  ];
  for (const word of forbidden) {
    assert.ok(!schemaText.includes(word), `schema should not include ${word}`);
    assert.ok(!extensionSource.includes(word), `tool description/source should not include ${word}`);
  }
  assert.ok(!schemaText.includes("agentScope"), "schema should not include agentScope");
  assert.ok(!schemaText.includes("artifacts"), "schema should not include artifacts");
});
