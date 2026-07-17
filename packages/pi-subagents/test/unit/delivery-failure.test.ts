import assert from "node:assert/strict";
import test from "node:test";
import { formatDeliveryFailure } from "../../src/intercom-public/delivery-failure.ts";

test("terminated targets direct subagent callers to result channel", () => {
  assert.match(
    formatDeliveryFailure({ code: "expired-target" }),
    /completed subagent results arrive through subagent\(\), not Intercom/,
  );
});
