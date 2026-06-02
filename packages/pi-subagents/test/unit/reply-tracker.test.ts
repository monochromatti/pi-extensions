import assert from "node:assert/strict";
import test from "node:test";
import { ReplyTracker } from "../../src/intercom-public/reply-tracker.ts";
import type { Message, SessionInfo } from "../../src/intercom-public/types.ts";

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

function ask(id: string): Message {
  return {
    id,
    timestamp: Date.now(),
    expectsReply: true,
    content: { text: `ask ${id}` },
  };
}

test("reply without replyTo fails when multiple pending asks exist and lists candidates", () => {
  const tracker = new ReplyTracker();
  tracker.recordIncomingMessage(session("sender-a"), ask("ask-a"));
  tracker.recordIncomingMessage(session("sender-b"), ask("ask-b"));

  assert.throws(
    () => tracker.resolveReplyTarget({}),
    /Multiple pending asks.*replyTo.*ask-a.*sender-a.*ask-b.*sender-b/s,
  );
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
