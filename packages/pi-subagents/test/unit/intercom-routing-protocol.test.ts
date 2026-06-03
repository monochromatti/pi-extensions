import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { IntercomClient } from "../../src/intercom-public/broker/client.ts";
import { createMessageReader, writeMessage } from "../../src/intercom-public/broker/framing.ts";
import { getBrokerSocketPath } from "../../src/intercom-public/broker/paths.ts";
import { type DeliveredMessage, type SendTargetEnvelope } from "../../src/intercom-public/types.ts";

const packageDir = process.cwd().endsWith(path.join("packages", "pi-subagents"))
  ? process.cwd()
  : path.join(process.cwd(), "packages/pi-subagents");
const repoDir = path.dirname(path.dirname(packageDir));

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBrokerReady(broker: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Broker startup timed out"));
    }, 10000);

    const onStdout = (chunk: Buffer) => {
      if (chunk.toString().includes("Intercom broker started")) {
        cleanup();
        resolve();
      }
    };

    const onStderr = (chunk: Buffer) => {
      const text = chunk.toString();
      if (/Error|ERR_|SyntaxError/.test(text)) {
        cleanup();
        reject(new Error(text));
      }
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Broker exited before startup (code=${code}, signal=${signal})`));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      broker.stdout.off("data", onStdout);
      broker.stderr.off("data", onStderr);
      broker.off("exit", onExit);
    };

    broker.stdout.on("data", onStdout);
    broker.stderr.on("data", onStderr);
    broker.once("exit", onExit);
  });
}

async function withBroker<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const sharedHome = mkdtempSync(path.join(tmpdir(), "pi-subagents-routing-home-"));
  const broker = spawn(process.execPath, [
    "--experimental-transform-types",
    path.join(packageDir, "src/intercom-public/broker/broker.ts"),
  ], {
    cwd: repoDir,
    env: { ...process.env, HOME: sharedHome, USERPROFILE: sharedHome },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForBrokerReady(broker);
    return await fn(sharedHome);
  } finally {
    broker.kill("SIGTERM");
    await once(broker, "exit").catch(() => undefined);
    rmSync(sharedHome, { recursive: true, force: true });
  }
}

async function connectClient(homeDir: string, session: {
  alias: string;
  piSessionId: string;
  namespace?: string;
  cwd?: string;
  leaseTtlMs?: number;
}): Promise<IntercomClient> {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  const client = new IntercomClient();
  try {
    await client.connect({
      alias: session.alias,
      piSessionId: session.piSessionId,
      namespace: session.namespace ?? "test-namespace",
      cwd: session.cwd ?? `/tmp/${session.alias}`,
      model: "test-model",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      leaseTtlMs: session.leaseTtlMs ?? 30_000,
      heartbeatIntervalMs: 10_000,
      status: "idle",
    });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  }

  return client;
}

async function connectRawClient(homeDir: string, session: Record<string, unknown>): Promise<IntercomClient> {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  const client = new IntercomClient();
  try {
    await client.connect(session as never);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  }
  return client;
}

async function disconnectAll(clients: IntercomClient[]): Promise<void> {
  await Promise.all(clients.map(async (client) => {
    try {
      await client.disconnect();
    } catch {
      // test cleanup
    }
  }));
}

function createInbox(client: IntercomClient): { messages: DeliveredMessage[]; dispose: () => void } {
  const messages: DeliveredMessage[] = [];
  const onMessage = (_from: unknown, message: DeliveredMessage) => {
    messages.push(message);
  };
  client.on("message", onMessage);
  return {
    messages,
    dispose: () => client.off("message", onMessage),
  };
}

async function waitForReceivedMessage(messages: DeliveredMessage[], expectedText: string): Promise<DeliveredMessage> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const hit = messages.find((message) => message.content.text === expectedText);
    if (hit) {
      return hit;
    }
    await wait(25);
  }

  throw new Error(`Timed out waiting for message: ${expectedText}`);
}

test("broker routes duplicate aliases by exact intercomSessionId", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const targetA = await connectClient(homeDir, { alias: "dup", piSessionId: "pi-a", cwd: "/work/a" });
    const targetB = await connectClient(homeDir, { alias: "dup", piSessionId: "pi-b", cwd: "/work/b" });
    const sender = await connectClient(homeDir, { alias: "sender", piSessionId: "pi-sender", cwd: "/work/sender" });
    const inboxA = createInbox(targetA);
    const inboxB = createInbox(targetB);

    try {
      const idA = targetA.sessionId;
      const idB = targetB.sessionId;
      assert.ok(idA);
      assert.ok(idB);
      assert.notEqual(idA, idB);

      const sendA = await sender.sendMachine({ kind: "intercom-session", intercomSessionId: idA }, { text: "to-target-a" });
      const sendB = await sender.sendManual({ kind: "intercom-session", intercomSessionId: idB }, { text: "to-target-b" });

      assert.equal(sendA.delivered, true);
      assert.equal(sendB.delivered, true);

      const receivedA = await waitForReceivedMessage(inboxA.messages, "to-target-a");
      const receivedB = await waitForReceivedMessage(inboxB.messages, "to-target-b");

      assert.equal(receivedA.content.text, "to-target-a");
      assert.equal(receivedB.content.text, "to-target-b");
    } finally {
      inboxA.dispose();
      inboxB.dispose();
      await disconnectAll([sender, targetA, targetB]);
    }
  });
});

test("identity snapshot reconnect policy controls stale intercomSessionId re-resolution", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const target = await connectClient(homeDir, { alias: "supervisor", piSessionId: "pi-parent", cwd: "/work/parent" });
    const sender = await connectClient(homeDir, { alias: "child", piSessionId: "pi-child", cwd: "/work/child" });
    const inbox = createInbox(target);

    try {
      const strict = await sender.sendManual({
        kind: "identity-snapshot",
        intercomSessionId: "stale-id",
        piSessionId: "pi-parent",
        alias: "supervisor",
        reconnect: "same-intercom-session",
      }, {
        text: "must-not-reresolve-with-strict-policy",
      });
      assert.equal(strict.delivered, false);
      assert.equal(strict.failure?.code, "expired-target");

      const fallback = await sender.sendManual({
        kind: "identity-snapshot",
        intercomSessionId: "stale-id",
        piSessionId: "pi-parent",
        alias: "supervisor",
        reconnect: "same-pi-session-if-unique",
      }, {
        text: "reresolved-by-pi-session-id",
      });

      assert.equal(fallback.delivered, true);
      const received = await waitForReceivedMessage(inbox.messages, "reresolved-by-pi-session-id");
      assert.equal(received.content.text, "reresolved-by-pi-session-id");
    } finally {
      inbox.dispose();
      await disconnectAll([sender, target]);
    }
  });
});

test("delivered frames always include resolved exact receiver identity", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const target = await connectClient(homeDir, { alias: "receiver", piSessionId: "pi-receiver", cwd: "/work/receiver" });
    const sender = await connectClient(homeDir, { alias: "sender", piSessionId: "pi-sender", cwd: "/work/sender" });
    const inbox = createInbox(target);

    try {
      const structured = await sender.sendManual({
        kind: "identity-snapshot",
        intercomSessionId: target.sessionId ?? undefined,
        piSessionId: "pi-receiver",
        alias: "receiver",
        reconnect: "same-pi-session-if-unique",
      }, {
        text: "structured-metadata",
      });
      assert.equal(structured.delivered, true);

      const structuredMessage = await waitForReceivedMessage(inbox.messages, "structured-metadata");
      assert.equal(structuredMessage.to.intercomSessionId, target.sessionId);
      assert.equal(structuredMessage.to.piSessionId, "pi-receiver");
      assert.equal(structuredMessage.to.alias, "receiver");

      const manual = await sender.sendManual({ kind: "scoped-alias", alias: "receiver", namespace: "test-namespace" }, { text: "manual-resolved-metadata" });
      assert.equal(manual.delivered, true);

      const manualMessage = await waitForReceivedMessage(inbox.messages, "manual-resolved-metadata");
      assert.equal(manualMessage.to.intercomSessionId, target.sessionId);
      assert.equal(manualMessage.to.piSessionId, "pi-receiver");
      assert.equal(manualMessage.to.alias, "receiver");
    } finally {
      inbox.dispose();
      await disconnectAll([sender, target]);
    }
  });
});

test("duplicate manual aliases return deterministic candidate error", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const targetA = await connectClient(homeDir, { alias: "worker", piSessionId: "pi-worker-a", cwd: "/repo/a" });
    const targetB = await connectClient(homeDir, { alias: "worker", piSessionId: "pi-worker-b", cwd: "/repo/b" });
    const sender = await connectClient(homeDir, { alias: "sender", piSessionId: "pi-sender" });
    const inboxA = createInbox(targetA);
    const inboxB = createInbox(targetB);

    try {
      const result = await sender.sendManual("worker", { text: "ambiguous-manual" });
      assert.equal(result.delivered, false);
      assert.equal(result.failure?.code, "ambiguous-alias");
      assert.equal(result.failure?.candidates.length, 2);
      assert.equal(result.failure?.candidates.some((candidate) => candidate.intercomSessionId === targetA.sessionId), true);
      assert.equal(result.failure?.candidates.some((candidate) => candidate.intercomSessionId === targetB.sessionId), true);
      assert.equal(result.failure?.candidates.some((candidate) => candidate.cwd === "/repo/a"), true);
      assert.equal(result.failure?.candidates.some((candidate) => candidate.cwd === "/repo/b"), true);
    } finally {
      await disconnectAll([sender, targetA, targetB]);
    }
  });
});

test("namespace constrains alias lookup, exact IDs ignore namespace", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const targetA = await connectClient(homeDir, {
      alias: "dupe",
      piSessionId: "pi-a",
      namespace: "team-a",
      cwd: "/repo/team-a",
    });
    const targetB = await connectClient(homeDir, {
      alias: "dupe",
      piSessionId: "pi-b",
      namespace: "team-b",
      cwd: "/repo/team-b",
    });
    const sender = await connectClient(homeDir, { alias: "sender", piSessionId: "pi-sender" });
    const inboxA = createInbox(targetA);
    const inboxB = createInbox(targetB);

    try {
      const namespacedAlias: SendTargetEnvelope = { kind: "scoped-alias", alias: "dupe", namespace: "team-a" };
      const byAlias = await sender.sendManual(namespacedAlias, { text: "namespace-hit-team-a" });
      assert.equal(byAlias.delivered, true);
      await waitForReceivedMessage(inboxA.messages, "namespace-hit-team-a");

      const exactByIdWrongNamespace: SendTargetEnvelope = {
        kind: "intercom-session",
        intercomSessionId: targetB.sessionId ?? undefined,
      };
      const byId = await sender.sendManual(exactByIdWrongNamespace, { text: "id-ignores-namespace" });
      assert.equal(byId.delivered, true);
      await waitForReceivedMessage(inboxB.messages, "id-ignores-namespace");

      const staleIdWithPiFallbackWrongNamespace: SendTargetEnvelope = {
        kind: "identity-snapshot",
        intercomSessionId: "stale",
        piSessionId: "pi-b",
        alias: "dupe",
        reconnect: "same-pi-session-if-unique",
      };
      const byPi = await sender.sendManual(staleIdWithPiFallbackWrongNamespace, { text: "pi-id-ignores-namespace" });
      assert.equal(byPi.delivered, true);
      await waitForReceivedMessage(inboxB.messages, "pi-id-ignores-namespace");

      const namespaceMiss: SendTargetEnvelope = { kind: "scoped-alias", alias: "dupe", namespace: "missing-team" };
      const miss = await sender.sendManual(namespaceMiss, { text: "must-not-cross-namespace" });
      assert.equal(miss.delivered, false);
      assert.equal(miss.failure?.code, "target-not-found");
      assert.equal(inboxA.messages.some((message) => message.content.text === "must-not-cross-namespace"), false);
      assert.equal(inboxB.messages.some((message) => message.content.text === "must-not-cross-namespace"), false);
    } finally {
      inboxA.dispose();
      inboxB.dispose();
      await disconnectAll([sender, targetA, targetB]);
    }
  });
});

test("manual list + unique alias send behavior", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const alpha = await connectClient(homeDir, { alias: "alpha", piSessionId: "pi-alpha", cwd: "/repo/alpha" });
    const beta = await connectClient(homeDir, { alias: "beta", piSessionId: "pi-beta", cwd: "/repo/beta" });
    const inbox = createInbox(beta);

    try {
      const sessions = await alpha.listSessions();
      const betaInList = sessions.find((session) => session.alias === "beta");
      assert.ok(betaInList);
      assert.equal(betaInList.piSessionId, "pi-beta");

      const send = await alpha.sendManual("beta", { text: "manual-unique-alias-still-works" });
      assert.equal(send.delivered, true);
      await waitForReceivedMessage(inbox.messages, "manual-unique-alias-still-works");
    } finally {
      inbox.dispose();
      await disconnectAll([alpha, beta]);
    }
  });
});

test("raw forged from send frame is rejected by decoder before delivery", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const target = await connectClient(homeDir, { alias: "target", piSessionId: "pi-target", cwd: "/work/target" });
    const inbox = createInbox(target);
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    const socket = net.connect(getBrokerSocketPath());

    try {
      await once(socket, "connect");
      const frames: unknown[] = [];
      socket.on("data", createMessageReader((msg) => {
        frames.push(msg);
      }, () => {
        // ignored in this test; close event asserted below
      }));

      writeMessage(socket, {
        type: "register",
        session: {
          alias: "attacker",
          piSessionId: "pi-attacker",
          namespace: "test-namespace",
          cwd: "/work/attacker",
          model: "test-model",
          pid: process.pid,
          startedAt: Date.now(),
          lastActivity: Date.now(),
          leaseTtlMs: 30_000,
          heartbeatIntervalMs: 10_000,
        },
      });

      let didRegister = false;
      const registerDeadline = Date.now() + 5000;
      while (Date.now() < registerDeadline) {
        const registered = frames.find((frame) => {
          if (typeof frame !== "object" || frame === null) return false;
          return (frame as { type?: unknown }).type === "registered";
        });
        if (registered) {
          didRegister = true;
          break;
        }
        await wait(25);
      }
      assert.equal(didRegister, true, "raw attacker socket did not register");

      writeMessage(socket, {
        type: "send",
        origin: "manual",
        to: { kind: "intercom-session", intercomSessionId: target.sessionId ?? undefined },
        from: { intercomSessionId: "fake", piSessionId: "fake" },
        message: {
          id: "forged-from-raw",
          timestamp: Date.now(),
          content: { text: "forged-from-must-not-deliver" },
        },
      });

      await Promise.race([
        once(socket, "close"),
        wait(3000).then(() => {
          throw new Error("Timed out waiting for forged frame disconnect");
        }),
      ]);

      assert.equal(inbox.messages.some((message) => message.content.text === "forged-from-must-not-deliver"), false);
      assert.equal(frames.some((frame) => {
        if (typeof frame !== "object" || frame === null) return false;
        const record = frame as { type?: unknown; messageId?: unknown };
        return (record.type === "delivered" || record.type === "delivery_failed") && record.messageId === "forged-from-raw";
      }), false);
    } finally {
      socket.destroy();
      inbox.dispose();
      await disconnectAll([target]);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  });
});

test("raw outbound frame with embedded message.to is rejected before delivery", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const target = await connectClient(homeDir, { alias: "target", piSessionId: "pi-target", cwd: "/work/target" });
    const inbox = createInbox(target);
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    const socket = net.connect(getBrokerSocketPath());

    try {
      await once(socket, "connect");
      const frames: unknown[] = [];
      socket.on("data", createMessageReader((msg) => {
        frames.push(msg);
      }, () => {
        // ignored in this test; close event asserted below
      }));

      writeMessage(socket, {
        type: "register",
        session: {
          alias: "attacker",
          piSessionId: "pi-attacker",
          namespace: "test-namespace",
          cwd: "/work/attacker",
          model: "test-model",
          pid: process.pid,
          startedAt: Date.now(),
          lastActivity: Date.now(),
          leaseTtlMs: 30_000,
          heartbeatIntervalMs: 10_000,
        },
      });

      let didRegister = false;
      const registerDeadline = Date.now() + 5000;
      while (Date.now() < registerDeadline) {
        const registered = frames.find((frame) => {
          if (typeof frame !== "object" || frame === null) return false;
          return (frame as { type?: unknown }).type === "registered";
        });
        if (registered) {
          didRegister = true;
          break;
        }
        await wait(25);
      }
      assert.equal(didRegister, true, "raw attacker socket did not register");

      writeMessage(socket, {
        type: "send",
        origin: "manual",
        to: { kind: "intercom-session", intercomSessionId: target.sessionId ?? undefined },
        message: {
          id: "outbound-embedded-to",
          timestamp: Date.now(),
          to: { intercomSessionId: target.sessionId ?? undefined, piSessionId: "pi-target" },
          content: { text: "embedded-target-must-not-deliver" },
        },
      });

      await Promise.race([
        once(socket, "close"),
        wait(3000).then(() => {
          throw new Error("Timed out waiting for invalid outbound frame disconnect");
        }),
      ]);

      assert.equal(inbox.messages.some((message) => message.content.text === "embedded-target-must-not-deliver"), false);
      assert.equal(frames.some((frame) => {
        if (typeof frame !== "object" || frame === null) return false;
        const record = frame as { type?: unknown; messageId?: unknown };
        return (record.type === "delivered" || record.type === "delivery_failed") && record.messageId === "outbound-embedded-to";
      }), false);
    } finally {
      socket.destroy();
      inbox.dispose();
      await disconnectAll([target]);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  });
});

test("machine send rejects alias targets at client boundary and keeps socket connected", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const target = await connectClient(homeDir, { alias: "target", piSessionId: "pi-target", cwd: "/work/target" });
    const sender = await connectClient(homeDir, { alias: "sender", piSessionId: "pi-sender", cwd: "/work/sender" });
    const inbox = createInbox(target);
    try {
      const byString = await sender.sendMachine("target" as never, {
        text: "machine-string-alias-must-not-deliver",
      });
      assert.equal(byString.delivered, false);
      assert.equal(byString.failure?.code, "unsafe-machine-alias-target");

      const byScopedAlias = await sender.sendMachine({ kind: "scoped-alias", alias: "target", namespace: "test-namespace" } as never, {
        text: "machine-scoped-alias-must-not-deliver",
      });
      assert.equal(byScopedAlias.delivered, false);
      assert.equal(byScopedAlias.failure?.code, "unsafe-machine-alias-target");

      assert.equal(sender.isConnected(), true);
      assert.equal(inbox.messages.some((message) => message.content.text.includes("must-not-deliver")), false);
    } finally {
      inbox.dispose();
      await disconnectAll([sender, target]);
    }
  });
});

test("raw machine send with alias target is rejected by decoder before delivery", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const target = await connectClient(homeDir, { alias: "target", piSessionId: "pi-target", cwd: "/work/target" });
    const inbox = createInbox(target);
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    const socket = net.connect(getBrokerSocketPath());
    const frames: unknown[] = [];

    try {
      await once(socket, "connect");
      socket.on("data", createMessageReader((msg) => {
        frames.push(msg);
      }, () => {
        // ignore; close asserted below
      }));

      writeMessage(socket, {
        type: "register",
        session: {
          alias: "attacker",
          piSessionId: "pi-attacker",
          namespace: "test-namespace",
          cwd: "/work/attacker",
          model: "test-model",
          pid: process.pid,
          startedAt: Date.now(),
          lastActivity: Date.now(),
          leaseTtlMs: 30_000,
          heartbeatIntervalMs: 10_000,
        },
      });

      let didRegister = false;
      const registerDeadline = Date.now() + 5000;
      while (Date.now() < registerDeadline) {
        const registered = frames.find((frame) => {
          if (typeof frame !== "object" || frame === null) return false;
          return (frame as { type?: unknown }).type === "registered";
        });
        if (registered) {
          didRegister = true;
          break;
        }
        await wait(25);
      }
      assert.equal(didRegister, true, "raw attacker socket did not register");

      writeMessage(socket, {
        type: "send",
        origin: "machine",
        to: {
          kind: "scoped-alias",
          alias: "target",
          namespace: "test-namespace",
        },
        message: {
          id: "machine-alias-raw",
          timestamp: Date.now(),
          content: { text: "must-not-deliver" },
        },
      });

      await Promise.race([
        once(socket, "close"),
        wait(3000).then(() => {
          throw new Error("Timed out waiting for machine alias decoder disconnect");
        }),
      ]);

      assert.equal(inbox.messages.some((message) => message.content.text === "must-not-deliver"), false);
      assert.equal(frames.some((frame) => {
        if (typeof frame !== "object" || frame === null) return false;
        const record = frame as { type?: unknown; messageId?: unknown };
        return (record.type === "delivered" || record.type === "delivery_failed") && record.messageId === "machine-alias-raw";
      }), false);
    } finally {
      socket.destroy();
      inbox.dispose();
      await disconnectAll([target]);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  });
});

test("unregistered machine sends fail closed with unregistered-sender", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    const socket = net.connect(getBrokerSocketPath());
    try {
      await once(socket, "connect");
      const response = new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("raw unregistered send timed out")), 5000);
        socket.on("data", createMessageReader((msg) => {
          clearTimeout(timeout);
          resolve(msg);
        }, reject));
      });
      writeMessage(socket, {
        type: "send",
        origin: "machine",
        to: { kind: "pi-session", piSessionId: "pi-target" },
        message: {
          id: "unregistered-machine-message",
          timestamp: Date.now(),
          content: { text: "must-not-deliver" },
        },
      });
      assert.deepEqual(await response, {
        type: "delivery_failed",
        messageId: "unregistered-machine-message",
        failure: { code: "unregistered-sender" },
      });
    } finally {
      socket.destroy();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  });
});

test("expired sender session fails with forged-sender code", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const sender = await connectClient(homeDir, { alias: "sender", piSessionId: "pi-sender", leaseTtlMs: 50 });
    const target = await connectClient(homeDir, { alias: "target", piSessionId: "pi-target" });
    const sweeper = await connectClient(homeDir, { alias: "sweeper", piSessionId: "pi-sweeper" });
    const inbox = createInbox(target);
    try {
      await wait(80);
      await sweeper.listSessions();
      const result = await sender.sendManual({ kind: "intercom-session", intercomSessionId: target.sessionId ?? undefined }, { text: "forged-sender-after-expiry" });
      assert.equal(result.delivered, false);
      assert.equal(result.failure?.code, "forged-sender");
      assert.equal(inbox.messages.some((message) => message.content.text === "forged-sender-after-expiry"), false);
    } finally {
      inbox.dispose();
      await disconnectAll([sweeper, sender, target]);
    }
  });
});

test("duplicate live piSessionId blocks exact piSessionId resolution", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const targetA = await connectClient(homeDir, { alias: "dup-a", piSessionId: "pi-dup", cwd: "/work/a" });
    const targetB = await connectClient(homeDir, { alias: "dup-b", piSessionId: "pi-dup", cwd: "/work/b" });
    const sender = await connectClient(homeDir, { alias: "sender", piSessionId: "pi-sender" });
    const inboxA = createInbox(targetA);
    const inboxB = createInbox(targetB);
    try {
      const result = await sender.sendManual({ kind: "pi-session", piSessionId: "pi-dup" }, { text: "must-not-pick-duplicate" });
      assert.equal(result.delivered, false);
      assert.equal(result.failure?.code, "duplicate-pi-session");
      assert.equal(result.failure?.piSessionId, "pi-dup");
      assert.equal(result.failure?.candidates.some((candidate) => candidate.cwd === "/work/a"), true);
      assert.equal(result.failure?.candidates.some((candidate) => candidate.cwd === "/work/b"), true);

      const snapshot = await sender.sendManual({
        kind: "identity-snapshot",
        intercomSessionId: "stale-intercom",
        piSessionId: "pi-dup",
        reconnect: "same-pi-session-if-unique",
      }, { text: "snapshot-must-not-pick-duplicate" });
      assert.equal(snapshot.delivered, false);
      assert.equal(snapshot.failure?.code, "duplicate-pi-session");
      assert.equal(snapshot.failure?.piSessionId, "pi-dup");
      assert.equal(snapshot.failure?.candidates.some((candidate) => candidate.cwd === "/work/a"), true);
      assert.equal(snapshot.failure?.candidates.some((candidate) => candidate.cwd === "/work/b"), true);

      assert.equal(inboxA.messages.length, 0);
      assert.equal(inboxB.messages.length, 0);
    } finally {
      inboxA.dispose();
      inboxB.dispose();
      await disconnectAll([sender, targetA, targetB]);
    }
  });
});

test("broker owns registration lease start time", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    const client = new IntercomClient();
    try {
      await client.connect({
        alias: "future-lease",
        piSessionId: "pi-future-lease",
        namespace: "team",
        cwd: "/repo/future",
        model: "test-model",
        pid: process.pid,
        startedAt: Date.now(),
        lastActivity: Date.now() + 60_000,
        heartbeatIntervalMs: 10_000,
        leaseTtlMs: 50,
        status: "idle",
      });
      await wait(80);
      const sessions = await client.listSessions();
      assert.equal(sessions.some((session) => session.piSessionId === "pi-future-lease"), false);
    } finally {
      await disconnectAll([client]);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  });
});

test("expired sessions are ignored and heartbeat extends lease", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const expiring = await connectClient(homeDir, { alias: "ttl", piSessionId: "pi-ttl", cwd: "/work/ttl", leaseTtlMs: 80 });
    const keptAlive = await connectClient(homeDir, { alias: "alive", piSessionId: "pi-alive", cwd: "/work/alive", leaseTtlMs: 200 });
    const sender = await connectClient(homeDir, { alias: "sender", piSessionId: "pi-sender" });
    const aliveInbox = createInbox(keptAlive);
    try {
      await wait(130);
      const expiredByPi = await sender.sendManual({ kind: "pi-session", piSessionId: "pi-ttl" }, { text: "expired-pi" });
      assert.equal(expiredByPi.delivered, false);
      assert.equal(expiredByPi.failure?.code, "expired-target");
      const expiredByAlias = await sender.sendManual({ kind: "scoped-alias", alias: "ttl", namespace: "test-namespace" }, { text: "expired-alias" });
      assert.equal(expiredByAlias.delivered, false);
      assert.equal(expiredByAlias.failure?.code, "target-not-found");
      keptAlive.heartbeat();
      await wait(120);
      const alive = await sender.sendManual({ kind: "pi-session", piSessionId: "pi-alive" }, { text: "heartbeat-kept-alive" });
      assert.equal(alive.delivered, true);
      await waitForReceivedMessage(aliveInbox.messages, "heartbeat-kept-alive");
    } finally {
      aliveInbox.dispose();
      await disconnectAll([sender, keptAlive, expiring]);
    }
  });
});

test("duplicate alias in same namespace returns ambiguity with identity candidates", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const targetA = await connectClient(homeDir, { alias: "same", piSessionId: "pi-a", namespace: "team", cwd: "/repo/a" });
    const targetB = await connectClient(homeDir, { alias: "same", piSessionId: "pi-b", namespace: "team", cwd: "/repo/b" });
    const sender = await connectClient(homeDir, { alias: "sender", piSessionId: "pi-sender", namespace: "team" });
    try {
      const result = await sender.sendManual({ kind: "scoped-alias", alias: "same", namespace: "team" }, { text: "ambiguous-team" });
      assert.equal(result.delivered, false);
      assert.equal(result.failure?.code, "ambiguous-alias");
      assert.equal(result.failure?.candidates.some((candidate) => candidate.piSessionId === "pi-a"), true);
      assert.equal(result.failure?.candidates.some((candidate) => candidate.piSessionId === "pi-b"), true);
      assert.equal(result.failure?.candidates.some((candidate) => candidate.namespace === "team"), true);
      assert.equal(result.failure?.candidates.some((candidate) => typeof candidate.leaseExpiresAt === "number"), true);
    } finally {
      await disconnectAll([sender, targetA, targetB]);
    }
  });
});

test("alias lookup honors explicit alias when it differs from registered alias", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const target = await connectRawClient(homeDir, {
      alias: "exact-alias",
      piSessionId: "pi-alias",
      namespace: "team",
      cwd: "/repo/alias",
      model: "test-model",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      leaseTtlMs: 30_000,
      heartbeatIntervalMs: 10_000,
      status: "idle",
    });
    const sender = await connectClient(homeDir, { alias: "sender", piSessionId: "pi-sender", namespace: "team" });
    const inbox = createInbox(target);
    try {
      const result = await sender.sendManual({ kind: "scoped-alias", alias: "exact-alias", namespace: "team" }, { text: "alias-field-hit" });
      assert.equal(result.delivered, true);
      const received = await waitForReceivedMessage(inbox.messages, "alias-field-hit");
      assert.equal(received.to?.alias, "exact-alias");
    } finally {
      inbox.dispose();
      await disconnectAll([sender, target]);
    }
  });
});

test("alias lookup defaults to sender namespace and explicit global can be ambiguous", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const targetA = await connectClient(homeDir, { alias: "cross", piSessionId: "pi-a", namespace: "team-a", cwd: "/repo/a" });
    const targetB = await connectClient(homeDir, { alias: "cross", piSessionId: "pi-b", namespace: "team-b", cwd: "/repo/b" });
    const sender = await connectClient(homeDir, { alias: "sender", piSessionId: "pi-sender", namespace: "team-a" });
    const inboxA = createInbox(targetA);
    const inboxB = createInbox(targetB);
    try {
      const local = await sender.sendManual({ kind: "scoped-alias", alias: "cross", namespace: "team-a" }, { text: "namespace-default" });
      assert.equal(local.delivered, true);
      await waitForReceivedMessage(inboxA.messages, "namespace-default");
      assert.equal(inboxB.messages.some((message) => message.content.text === "namespace-default"), false);

      const global = await sender.sendManual({ kind: "global-alias", alias: "cross" }, { text: "global-ambiguous" });
      assert.equal(global.delivered, false);
      assert.equal(global.failure?.code, "ambiguous-alias");
      assert.equal(global.failure?.candidates.some((candidate) => candidate.namespace === "team-a"), true);
      assert.equal(global.failure?.candidates.some((candidate) => candidate.namespace === "team-b"), true);

      const exact = await sender.sendManual({ kind: "intercom-session", intercomSessionId: targetB.sessionId ?? undefined }, { text: "exact-global" });
      assert.equal(exact.delivered, true);
      await waitForReceivedMessage(inboxB.messages, "exact-global");
    } finally {
      inboxA.dispose();
      inboxB.dispose();
      await disconnectAll([sender, targetA, targetB]);
    }
  });
});

test("session readiness + subagent metadata roundtrip via registration/presence", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    const child = new IntercomClient();
    const observer = new IntercomClient();
    try {
      await child.connect({
        alias: "child",
        piSessionId: "pi-child",
        namespace: "test-namespace",
        cwd: "/repo/child",
        model: "child-model",
        pid: process.pid,
        startedAt: Date.now(),
        lastActivity: Date.now(),
        leaseTtlMs: 30_000,
        heartbeatIntervalMs: 10_000,
        status: "idle",
        readiness: { state: "initializing", updatedAt: Date.now() },
        subagent: {
          ownerPiSessionId: "pi-parent",
          runId: "run-123",
          agent: "worker",
          index: 0,
        },
      });
      await observer.connect({
        alias: "observer",
        piSessionId: "pi-observer",
        namespace: "test-namespace",
        cwd: "/repo/observer",
        model: "observer-model",
        pid: process.pid,
        startedAt: Date.now(),
        lastActivity: Date.now(),
        leaseTtlMs: 30_000,
        heartbeatIntervalMs: 10_000,
        status: "idle",
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }

    try {
      const listed = (await observer.listSessions()).find((session) => session.alias === "child");
      assert.ok(listed);
      assert.equal(listed.readiness?.state, "initializing");
      assert.equal(listed.subagent?.ownerPiSessionId, "pi-parent");
      assert.equal(listed.subagent?.runId, "run-123");
      assert.equal(listed.subagent?.agent, "worker");
      assert.equal(listed.subagent?.index, 0);

      child.updatePresence({ readiness: { state: "ready", updatedAt: Date.now() } });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const refreshed = (await observer.listSessions()).find((session) => session.alias === "child");
        if (refreshed?.readiness?.state === "ready") {
          return;
        }
        await wait(25);
      }
      assert.fail("Timed out waiting for readiness=ready");
    } finally {
      await disconnectAll([observer, child]);
    }
  });
});

test("presence updates reject unknown legacy fields", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const target = await connectClient(homeDir, { alias: "stable-alias", piSessionId: "pi-stable", cwd: "/work/stable" });
    const observer = await connectClient(homeDir, { alias: "observer", piSessionId: "pi-observer", cwd: "/work/observer" });

    try {
      target.updatePresence({ status: "thinking" });
      target.updatePresence({ model: "stable-model-v2" });
      target.updatePresence({ readiness: { state: "ready", updatedAt: Date.now() } });
      target.updatePresence({ name: "mutated-name", alias: "mutated-alias", status: "thinking-again" } as never);

      const disconnectedDeadline = Date.now() + 5000;
      while (Date.now() < disconnectedDeadline && target.isConnected()) {
        await wait(25);
      }
      assert.equal(target.isConnected(), false, "target should disconnect after invalid presence payload");

      const removedDeadline = Date.now() + 5000;
      while (Date.now() < removedDeadline) {
        const refreshed = (await observer.listSessions()).find((session) => session.piSessionId === "pi-stable");
        if (!refreshed) {
          return;
        }
        await wait(25);
      }

      assert.fail("Timed out waiting for invalid-presence session removal");
    } finally {
      await disconnectAll([observer, target]);
    }
  });
});
