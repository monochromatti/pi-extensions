import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildChainTaskWithIoInstructions,
  renderChainTaskTemplate,
  resolveChainIoPath,
} from "../../src/runs/foreground/chain-execution.ts";

const chainSource = fs.readFileSync(
  new URL("../../src/runs/foreground/chain-execution.ts", import.meta.url),
  "utf8",
);

test("5.1/5.2 chain task templates pass previous output in memory", () => {
  assert.equal(
    renderChainTaskTemplate("summarize: {previous}", "original request", "step one output"),
    "summarize: step one output",
  );
});

test("5.3/5.4 chain task templates substitute original task", () => {
  assert.equal(
    renderChainTaskTemplate("plan for {task}; prior={previous}", "build feature", "research notes"),
    "plan for build feature; prior=research notes",
  );
});

test("5.7/5.8 chain execution source has no chain-file contract", () => {
  assert.ok(!chainSource.includes("createChainDir"));
  assert.ok(!chainSource.includes("writeInitialProgressFile"));
  assert.ok(!chainSource.includes("progress.md"));
  assert.ok(!chainSource.includes("ChainClarifyComponent"));
  assert.ok(!chainSource.includes("ctx.ui.custom"));
});

test("5.7 chain template rejects removed chain directory variable", () => {
  assert.throws(
    () => renderChainTaskTemplate("write {chain_dir}/out.md", "task", "previous"),
    /template variable is not supported/,
  );
});

test("5.9/5.10 chain output and reads resolve cwd-relative, not artifact-relative", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-chain-test-"));
  const parentCwd = path.join(temp, "parent");
  const topCwd = path.join(temp, "top");
  const stepCwd = path.join(temp, "step");

  assert.equal(resolveChainIoPath("out.md", stepCwd, topCwd, parentCwd), path.join(stepCwd, "out.md"));
  assert.equal(resolveChainIoPath("out.md", undefined, topCwd, parentCwd), path.join(topCwd, "out.md"));
  assert.equal(resolveChainIoPath("out.md", undefined, undefined, parentCwd), path.join(parentCwd, "out.md"));
  assert.equal(resolveChainIoPath(path.join(temp, "abs.md"), stepCwd, topCwd, parentCwd), path.join(temp, "abs.md"));

  const prepared = buildChainTaskWithIoInstructions({
    task: "do work",
    behavior: { reads: ["input.md"], output: "out.md" },
    stepCwd,
    topCwd,
    parentCwd,
  });
  assert.equal(prepared.outputPath, path.join(stepCwd, "out.md"));
  assert.match(prepared.task, new RegExp(`\\[Read from: ${path.join(stepCwd, "input.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`));
  assert.match(prepared.task, new RegExp(`\\[Write to: ${path.join(stepCwd, "out.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`));
});
