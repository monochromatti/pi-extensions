import assert from "node:assert/strict";
import test from "node:test";
import { createMessageReader } from "../../src/intercom-public/broker/framing.ts";

test("message reader rejects oversized frame before payload parse", () => {
  const errors: Error[] = [];
  const delivered: unknown[] = [];
  const reader = createMessageReader(
    (msg) => delivered.push(msg),
    (error) => errors.push(error),
    { maxFrameSizeBytes: 32 },
  );

  const header = Buffer.alloc(4);
  header.writeUInt32BE(33, 0);

  reader(header);

  assert.equal(delivered.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.message ?? "", /intercom_protocol\/frame_too_large:length=33,max=32/);
});
