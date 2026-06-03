import assert from "node:assert/strict";
import test from "node:test";
import { decodeBrokerFrame, decodeClientFrame } from "../../src/intercom-public/broker/protocol.ts";

function validSendFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "send",
    origin: "manual",
    to: { kind: "scoped-alias", alias: "receiver", namespace: "team-a" },
    message: {
      id: "msg-1",
      timestamp: Date.now(),
      content: {
        text: "hello",
      },
    },
    ...overrides,
  };
}

test("client decoder rejects unknown top-level keys and forged from field", () => {
  assert.throws(
    () => decodeClientFrame(validSendFrame({ unexpected: true })),
    /intercom_protocol\/client\/send\.unknown_key\.unexpected/,
  );

  assert.throws(
    () => decodeClientFrame(validSendFrame({ from: { intercomSessionId: "attacker" } })),
    /intercom_protocol\/client\/send\.forged_from/,
  );
});

test("client decoder requires valid send origin", () => {
  const missingOrigin = validSendFrame();
  delete missingOrigin.origin;

  assert.throws(
    () => decodeClientFrame(missingOrigin),
    /intercom_protocol\/client\/send\.origin/,
  );

  assert.throws(
    () => decodeClientFrame(validSendFrame({ origin: "robot" })),
    /intercom_protocol\/client\/send\.origin/,
  );
});

test("client decoder rejects string targets and invalid target object shapes", () => {
  assert.throws(
    () => decodeClientFrame(validSendFrame({ to: "receiver" })),
    /intercom_protocol\/client\/send\.to\.not_object/,
  );

  assert.throws(
    () => decodeClientFrame(validSendFrame({ to: {} })),
    /intercom_protocol\/client\/send\.to\.kind/,
  );

  assert.throws(
    () => decodeClientFrame(validSendFrame({
      to: {
        kind: "intercom-session",
        intercomSessionId: "intercom-1",
        alias: "receiver",
      },
    })),
    /intercom_protocol\/client\/send\.to\.unknown_key\.alias/,
  );

  assert.throws(
    () => decodeClientFrame(validSendFrame({
      message: {
        id: "msg-2",
        timestamp: Date.now(),
        to: { intercomSessionId: "session-2", piSessionId: "pi-2" },
        content: { text: "with-to" },
      },
    })),
    /intercom_protocol\/client\/send\.message\.unknown_key\.to/,
  );
});

test("client decoder supports discriminated structured target kinds", () => {
  const intercom = decodeClientFrame(validSendFrame({
    to: { kind: "intercom-session", intercomSessionId: "intercom-1" },
  }));
  const pi = decodeClientFrame(validSendFrame({
    to: { kind: "pi-session", piSessionId: "pi-1" },
  }));
  const snapshot = decodeClientFrame(validSendFrame({
    to: {
      kind: "identity-snapshot",
      intercomSessionId: "intercom-1",
      piSessionId: "pi-1",
      alias: "receiver",
      reconnect: "same-pi-session-if-unique",
    },
  }));
  const scopedAlias = decodeClientFrame(validSendFrame({
    to: { kind: "scoped-alias", alias: "receiver", namespace: "team-a" },
  }));
  const globalAlias = decodeClientFrame(validSendFrame({
    to: { kind: "global-alias", alias: "receiver" },
  }));

  for (const decoded of [intercom, pi, snapshot, scopedAlias, globalAlias]) {
    assert.equal(decoded.type, "send");
    assert.notEqual(typeof decoded.to, "string");
  }

  if (snapshot.type !== "send" || typeof snapshot.to === "string") {
    assert.fail("Expected structured identity snapshot target");
  }
  assert.equal(snapshot.to.kind, "identity-snapshot");
  assert.equal(snapshot.to.reconnect, "same-pi-session-if-unique");
});

test("client decoder rejects alias targets on machine origin", () => {
  assert.throws(
    () => decodeClientFrame(validSendFrame({
      origin: "machine",
      to: { kind: "scoped-alias", alias: "receiver", namespace: "team-a" },
    })),
    /intercom_protocol\/client\/send\.machine_alias_target/,
  );

  assert.throws(
    () => decodeClientFrame(validSendFrame({
      origin: "machine",
      to: { kind: "global-alias", alias: "receiver" },
    })),
    /intercom_protocol\/client\/send\.machine_alias_target/,
  );
});

test("broker decoder rejects unknown keys and invalid nested shapes", () => {
  assert.throws(
    () => decodeBrokerFrame({ type: "delivered", messageId: "m1", extra: true }),
    /intercom_protocol\/broker\/delivered\.unknown_key\.extra/,
  );

  assert.throws(
    () => decodeBrokerFrame({
      type: "delivery_failed",
      messageId: "m1",
      failure: {
        code: "ambiguous-alias",
      },
    }),
    /intercom_protocol\/broker\/delivery_failed\.failure\.candidates/,
  );

  assert.throws(
    () => decodeBrokerFrame({
      type: "message",
      from: {
        id: "session-1",
        piSessionId: "pi-1",
        alias: "sender",
        namespace: "team",
        cwd: "/repo",
        model: "m",
        pid: 1,
        startedAt: Date.now(),
        lastActivity: Date.now(),
        leaseTtlMs: 30_000,
        heartbeatIntervalMs: 10_000,
      },
      message: {
        id: "m1",
        timestamp: Date.now(),
        to: { intercomSessionId: "session-target", piSessionId: "pi-target" },
        content: {
          text: "hello",
          extra: true,
        },
      },
    }),
    /intercom_protocol\/broker\/message\.message\.content\.unknown_key\.extra/,
  );

  assert.throws(
    () => decodeBrokerFrame({
      type: "message",
      from: {
        id: "session-1",
        piSessionId: "pi-1",
        alias: "sender",
        namespace: "team",
        cwd: "/repo",
        model: "m",
        pid: 1,
        startedAt: Date.now(),
        lastActivity: Date.now(),
        leaseTtlMs: 30_000,
        heartbeatIntervalMs: 10_000,
      },
      message: {
        id: "m2",
        timestamp: Date.now(),
        content: {
          text: "hello",
        },
      },
    }),
    /intercom_protocol\/broker\/message\.message\.to\.not_object/,
  );

  assert.throws(
    () => decodeBrokerFrame({
      type: "message",
      from: {
        id: "session-1",
        piSessionId: "pi-1",
        alias: "sender",
        namespace: "team",
        cwd: "/repo",
        model: "m",
        pid: 1,
        startedAt: Date.now(),
        lastActivity: Date.now(),
        leaseTtlMs: 30_000,
        heartbeatIntervalMs: 10_000,
      },
      message: {
        id: "m3",
        timestamp: Date.now(),
        to: { intercomSessionId: "target-only" },
        content: {
          text: "hello",
        },
      },
    }),
    /intercom_protocol\/broker\/message\.message\.to\.piSessionId/,
  );
});
