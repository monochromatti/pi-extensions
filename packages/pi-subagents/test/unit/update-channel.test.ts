import test from "node:test";
import assert from "node:assert/strict";
import { createUpdateChannel, isStaleAgentListenerError } from "../../src/runs/foreground/update-channel.ts";

test("update channel emits while open and stops after close", () => {
	const values: number[] = [];
	const channel = createUpdateChannel<number>((value) => values.push(value));

	assert.equal(channel.emit(1), true);
	channel.close();
	assert.equal(channel.emit(2), false);

	assert.deepEqual(values, [1]);
	assert.equal(channel.isClosed(), true);
});

test("update channel closes and drops future updates when callback throws", () => {
	let calls = 0;
	const errors: unknown[] = [];
	const channel = createUpdateChannel<number>(() => {
		calls++;
		throw new Error("Agent listener invoked outside active run");
	}, { onError: (error) => errors.push(error) });

	assert.equal(channel.emit(1), false);
	assert.equal(channel.emit(2), false);

	assert.equal(calls, 1);
	assert.equal(errors.length, 1);
	assert.equal(isStaleAgentListenerError(errors[0]), true);
	assert.equal(channel.isClosed(), true);
});

test("update channel can rethrow in explicit throw policy", () => {
	const channel = createUpdateChannel<number>(() => {
		throw new Error("boom");
	}, { errorPolicy: "throw" });

	assert.throws(() => channel.emit(1), /boom/);
	assert.equal(channel.isClosed(), true);
});
