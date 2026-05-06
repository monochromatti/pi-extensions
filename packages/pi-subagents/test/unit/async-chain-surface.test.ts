import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("6.x async chain path does not enter old chain-file/progress/worktree behavior", () => {
  const asyncSource = readSource("src/runs/background/async-execution.ts");
  const runnerSource = readSource("src/runs/background/subagent-runner.ts");
  const combined = `${asyncSource}\n${runnerSource}`;

  const forbidden = [
    "writeInitialProgressFile",
    "progress.md",
    "createWorktrees",
    "cleanupWorktrees",
    "diffWorktrees",
    "findWorktreeTaskCwdConflict",
    "formatWorktreeTaskCwdConflict",
    "formatWorktreeDiffSummary",
    "resolveExpectedWorktreeAgentCwd",
    "group.worktree",
    "worktree:",
  ];

  for (const word of forbidden) {
    assert.ok(!combined.includes(word), `async chain path should not contain ${word}`);
  }
});
