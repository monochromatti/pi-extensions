import assert from "node:assert/strict";
import test from "node:test";
import { resolveSubagentResultStatus } from "../../src/intercom/result-intercom.ts";

test("terminal blocked statuses override exit-code classification", () => {
  assert.equal(
    resolveSubagentResultStatus({ exitCode: 1, terminalStatus: "blocked_decision" }),
    "blocked_decision",
  );
  assert.equal(
    resolveSubagentResultStatus({ exitCode: 1, terminalStatus: "blocked_capability" }),
    "blocked_capability",
  );
});
