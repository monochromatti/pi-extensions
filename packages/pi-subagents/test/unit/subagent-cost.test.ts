import assert from "node:assert/strict";
import test from "node:test";
import { addSubagentCostToAssistantMessage, subagentCost } from "../../src/shared/subagent-cost.ts";

test("subagentCost reads foreground aggregate usage", () => {
	assert.equal(subagentCost({ results: [{ usage: { cost: { total: 0.12 } } }, { usage: { cost: { total: 0.03 } } }] }), 0.15);
});

test("subagentCost reads async model attempts without double counting", () => {
	assert.ok(Math.abs(subagentCost({
		results: [{ modelAttempts: [{ usage: { cost: { total: 0.2 } } }, { usage: { cost: { total: 0.4 } } }] }],
	}) - 0.6) < Number.EPSILON);
});

test("addSubagentCostToAssistantMessage preserves message and adds host-visible cost", () => {
	const message = {
		role: "assistant",
		content: [],
		usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
	} as never;
	const updated = addSubagentCostToAssistantMessage(message, 0.42) as typeof message;
	assert.equal(updated.usage.cost.total, 0.43);
	assert.equal(updated.usage.input, 10);
});
