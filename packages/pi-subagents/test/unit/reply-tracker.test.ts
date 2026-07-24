import assert from "node:assert/strict";
import test from "node:test";
import { ReplyTracker } from "../../src/intercom-public/reply-tracker.ts";
import type { DeliveredMessage, SessionInfo } from "../../src/intercom-public/types.ts";

function session(id: string, piSessionId = id): SessionInfo {
  return {
    id,
    piSessionId,
    alias: id,
    cwd: `/repo/${id}`,
    model: "test",
    pid: process.pid,
    startedAt: 1,
    lastActivity: 1,
  };
}

function ask(id: string): DeliveredMessage {
  return {
    id,
    timestamp: Date.now(),
    expectsReply: true,
    to: { intercomSessionId: "receiver", piSessionId: "pi-receiver" },
    content: { text: `ask ${id}` },
  };
}

test("reply without an incoming ask directs subagent callers to result artifacts", () => {
  const tracker = new ReplyTracker();
  assert.throws(
    () => tracker.resolveReplyTarget({}),
    /Cannot reply: no active incoming ask\. Completed subagent results arrive through subagent\(\), not Intercom\./,
  );
});

test("reply without replyTo fails when multiple pending asks exist and lists candidates", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(session("sender-a"), ask("ask-a"));
  tracker.recordIncomingMessage(session("sender-b"), ask("ask-b"));

  assert.throws(
    () => tracker.resolveReplyTarget({}),
    /Multiple pending asks.*replyTo.*ask-a.*sender-a.*ask-b.*sender-b/s,
  );
});

test("bare reply cannot select sole ask suppressed before host delivery", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(session("sender-a"), ask("ask-a"));

  assert.throws(
    () => tracker.resolveReplyTarget({}),
    /Cannot reply implicitly.*ask-a.*not delivered.*replyTo/s,
  );

  const explicit = tracker.resolveReplyTarget({ replyTo: "ask-a" });
  assert.equal(explicit.message.id, "ask-a");
});

test("sole host-delivered ask remains eligible for bare reply", () => {
  const tracker = new ReplyTracker();
  const context = tracker.recordIncomingMessage(session("sender-a"), ask("ask-a"));
  tracker.queueTurnContext(context);
  tracker.beginTurn();
  tracker.endTurn();

  const resolved = tracker.resolveReplyTarget({});
  assert.equal(resolved.message.id, "ask-a");
});

test("suppressed host delivery cancels queued implicit context without deleting pending ask", () => {
  const tracker = new ReplyTracker();
  const context = tracker.recordIncomingMessage(session("sender-a"), ask("ask-a"));
  tracker.queueTurnContext(context);
  tracker.cancelQueuedTurnContext("ask-a");
  tracker.beginTurn();

  assert.throws(
    () => tracker.resolveReplyTarget({}),
    /Cannot reply implicitly.*ask-a.*not delivered.*replyTo/s,
  );
  assert.equal(tracker.resolveReplyTarget({ replyTo: "ask-a" }).message.id, "ask-a");
});

test("back-to-back agent runs consume matching reply contexts without FIFO lag", () => {
  const tracker = new ReplyTracker();
  const first = tracker.recordIncomingMessage(session("sender-a"), ask("ask-a"));
  tracker.queueTurnContext(first);
  tracker.beginTurn();
  assert.equal(tracker.resolveReplyTarget({}).message.id, "ask-a");
  tracker.markReplied("ask-a");
  tracker.endTurn();

  const second = tracker.recordIncomingMessage(session("sender-b"), ask("ask-b"));
  tracker.queueTurnContext(second);
  tracker.beginTurn();
  assert.equal(tracker.resolveReplyTarget({}).message.id, "ask-b");
});

test("replyTo resolves exact original inbound message", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(session("sender-a"), ask("ask-a"));
  tracker.recordIncomingMessage(session("sender-b"), ask("ask-b"));

  const resolved = tracker.resolveReplyTarget({ replyTo: "ask-b" });
  assert.equal(resolved.message.id, "ask-b");
  assert.equal(resolved.from.id, "sender-b");
});

test("replied and expired pending asks are pruned", () => {
  const tracker = new ReplyTracker(10);
  tracker.recordIncomingMessage(session("sender-a"), ask("ask-a"), 100);
  tracker.recordIncomingMessage(session("sender-b"), ask("ask-b"), 100);
  tracker.markReplied("ask-a");
  assert.deepEqual(tracker.listPending(105).map((context) => context.message.id), ["ask-b"]);
  assert.deepEqual(tracker.listPending(111).map((context) => context.message.id), []);
});

test("reply context stores identity snapshot target with reconnect policy", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(session("sender-a", "pi-a"), ask("ask-a"));
  const resolved = tracker.resolveReplyTarget({ replyTo: "ask-a" });

  assert.deepEqual(resolved.replyTarget, {
    kind: "identity-snapshot",
    intercomSessionId: "sender-a",
    piSessionId: "pi-a",
    alias: "sender-a",
    reconnect: "same-pi-session-if-unique",
  });
});

test("reply context supports strict same-intercom reconnect policy", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(session("sender-a", "pi-a"), ask("ask-a"), Date.now(), "same-intercom-session");
  const resolved = tracker.resolveReplyTarget({ replyTo: "ask-a" });
  assert.equal(resolved.replyTarget.reconnect, "same-intercom-session");
});
