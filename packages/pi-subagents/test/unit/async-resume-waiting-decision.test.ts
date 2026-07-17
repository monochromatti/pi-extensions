import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { resolveAsyncResumeTarget } from "../../src/runs/background/async-resume.ts";

test("waiting-decision child remains a live exact resume target", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-wait-"));
  const asyncDir = path.join(root, "async", "run-1");
  const resultsDir = path.join(root, "results");
  fs.mkdirSync(asyncDir, { recursive: true });
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
    runId: "run-1",
    mode: "single",
    state: "waiting_decision",
    startedAt: Date.now(),
    cwd: root,
    steps: [{ agent: "worker", status: "waiting_decision", sessionFile: path.join(asyncDir, "child.jsonl") }],
  }));
  fs.writeFileSync(path.join(asyncDir, "child.jsonl"), "");

  try {
    const target = resolveAsyncResumeTarget({ id: "run-1", index: 0 }, {
      asyncDirRoot: path.join(root, "async"),
      resultsDir,
      kill: () => false,
    });
    assert.equal(target.kind, "live");
    assert.equal(target.agent, "worker");
    assert.equal(target.intercomTarget, "subagent-worker-run-1-1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
