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
import { type Message, type SendTargetEnvelope } from "../../src/intercom-public/types.ts";

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

function createInbox(client: IntercomClient): { messages: Message[]; dispose: () => void } {
  const messages: Message[] = [];
  const onMessage = (_from: unknown, message: Message) => {
    messages.push(message);
  };
  client.on("message", onMessage);
  return {
    messages,
    dispose: () => client.off("message", onMessage),
  };
}

async function waitForReceivedMessage(messages: Message[], expectedText: string): Promise<Message> {
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

      const sendA = await sender.send(idA, { text: "to-target-a" });
      const sendB = await sender.send(idB, { text: "to-target-b" });

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

test("broker structured target re-resolves stale intercomSessionId by piSessionId", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const target = await connectClient(homeDir, { alias: "supervisor", piSessionId: "pi-parent", cwd: "/work/parent" });
    const sender = await connectClient(homeDir, { alias: "child", piSessionId: "pi-child", cwd: "/work/child" });
    const inbox = createInbox(target);

    try {
      const result = await sender.send({
        intercomSessionId: "stale-id",
        piSessionId: "pi-parent",
        alias: "supervisor",
      }, {
        text: "reresolved-by-pi-session-id",
      });

      assert.equal(result.delivered, true);
      const received = await waitForReceivedMessage(inbox.messages, "reresolved-by-pi-session-id");
      assert.equal(received.content.text, "reresolved-by-pi-session-id");
    } finally {
      inbox.dispose();
      await disconnectAll([sender, target]);
    }
  });
});

test("structured sends include resolved receiver metadata; manual sends still deliver without requiring metadata", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const target = await connectClient(homeDir, { alias: "receiver", piSessionId: "pi-receiver", cwd: "/work/receiver" });
    const sender = await connectClient(homeDir, { alias: "sender", piSessionId: "pi-sender", cwd: "/work/sender" });
    const inbox = createInbox(target);

    try {
      const structured = await sender.send({
        intercomSessionId: target.sessionId ?? undefined,
        piSessionId: "pi-receiver",
        alias: "receiver",
      }, {
        text: "structured-metadata",
      });
      assert.equal(structured.delivered, true);

      const structuredMessage = await waitForReceivedMessage(inbox.messages, "structured-metadata");
      assert.equal(structuredMessage.to?.intercomSessionId, target.sessionId);
      assert.equal(structuredMessage.to?.piSessionId, "pi-receiver");
      assert.equal(structuredMessage.to?.alias, "receiver");

      const manual = await sender.send("receiver", { text: "manual-no-required-metadata" });
      assert.equal(manual.delivered, true);

      const manualMessage = await waitForReceivedMessage(inbox.messages, "manual-no-required-metadata");
      assert.equal(manualMessage.to, undefined);
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
      const result = await sender.send("worker", { text: "ambiguous-manual" });
      assert.equal(result.delivered, false);
      assert.match(result.reason ?? "", /Ambiguous target "worker"/);
      assert.match(result.reason ?? "", new RegExp(targetA.sessionId ?? ""));
      assert.match(result.reason ?? "", new RegExp(targetB.sessionId ?? ""));
      assert.match(result.reason ?? "", /cwd=\/repo\/a/);
      assert.match(result.reason ?? "", /cwd=\/repo\/b/);
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
      const namespacedAlias: SendTargetEnvelope = { alias: "dupe", namespace: "team-a" };
      const byAlias = await sender.send(namespacedAlias, { text: "namespace-hit-team-a" });
      assert.equal(byAlias.delivered, true);
      await waitForReceivedMessage(inboxA.messages, "namespace-hit-team-a");

      const exactByIdWrongNamespace: SendTargetEnvelope = {
        intercomSessionId: targetB.sessionId ?? undefined,
        alias: "dupe",
        namespace: "team-a",
      };
      const byId = await sender.send(exactByIdWrongNamespace, { text: "id-ignores-namespace" });
      assert.equal(byId.delivered, true);
      await waitForReceivedMessage(inboxB.messages, "id-ignores-namespace");

      const staleIdWithPiFallbackWrongNamespace: SendTargetEnvelope = {
        intercomSessionId: "stale",
        piSessionId: "pi-b",
        alias: "dupe",
        namespace: "team-a",
      };
      const byPi = await sender.send(staleIdWithPiFallbackWrongNamespace, { text: "pi-id-ignores-namespace" });
      assert.equal(byPi.delivered, true);
      await waitForReceivedMessage(inboxB.messages, "pi-id-ignores-namespace");

      const namespaceMiss: SendTargetEnvelope = { alias: "dupe", namespace: "missing-team" };
      const miss = await sender.send(namespaceMiss, { text: "must-not-cross-namespace" });
      assert.equal(miss.delivered, false);
      assert.equal(miss.reason, "Session not found");
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

      const send = await alpha.send("beta", { text: "manual-unique-alias-still-works" });
      assert.equal(send.delivered, true);
      await waitForReceivedMessage(inbox.messages, "manual-unique-alias-still-works");
    } finally {
      inbox.dispose();
      await disconnectAll([alpha, beta]);
    }
  });
});

test("broker rejects client-supplied from identity", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const target = await connectClient(homeDir, { alias: "target", piSessionId: "pi-target", cwd: "/work/target" });
    const sender = await connectClient(homeDir, { alias: "sender", piSessionId: "pi-sender", cwd: "/work/sender" });
    const inbox = createInbox(target);
    try {
      const result = await sender.send({ intercomSessionId: target.sessionId ?? undefined }, {
        text: "forged-from-must-not-deliver",
        from: { intercomSessionId: "attacker", piSessionId: "pi-attacker" },
      } as never);
      assert.equal(result.delivered, false);
      assert.equal(result.reason, "forged-from-field");
      assert.equal(inbox.messages.some((message) => message.content.text === "forged-from-must-not-deliver"), false);
    } finally {
      inbox.dispose();
      await disconnectAll([sender, target]);
    }
  });
});

test("machine messages reject alias-only targets", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const target = await connectClient(homeDir, { alias: "target", piSessionId: "pi-target", cwd: "/work/target" });
    const sender = await connectClient(homeDir, { alias: "sender", piSessionId: "pi-sender", cwd: "/work/sender" });
    const inbox = createInbox(target);
    try {
      const result = await sender.send({ alias: "target", namespace: "/work/target" }, {
        text: "machine-alias-must-not-deliver",
        origin: "machine",
      } as never);
      assert.equal(result.delivered, false);
      assert.equal(result.reason, "unsafe-machine-alias-target");
      assert.equal(inbox.messages.some((message) => message.content.text === "machine-alias-must-not-deliver"), false);
    } finally {
      inbox.dispose();
      await disconnectAll([sender, target]);
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
        to: { piSessionId: "pi-target" },
        message: {
          id: "unregistered-machine-message",
          timestamp: Date.now(),
          content: { text: "must-not-deliver" },
        },
      });
      assert.deepEqual(await response, {
        type: "delivery_failed",
        messageId: "unregistered-machine-message",
        reason: "unregistered-sender",
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

test("duplicate live piSessionId blocks exact piSessionId resolution", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const targetA = await connectClient(homeDir, { alias: "dup-a", piSessionId: "pi-dup", cwd: "/work/a" });
    const targetB = await connectClient(homeDir, { alias: "dup-b", piSessionId: "pi-dup", cwd: "/work/b" });
    const sender = await connectClient(homeDir, { alias: "sender", piSessionId: "pi-sender" });
    const inboxA = createInbox(targetA);
    const inboxB = createInbox(targetB);
    try {
      const result = await sender.send({ piSessionId: "pi-dup" }, { text: "must-not-pick-duplicate" });
      assert.equal(result.delivered, false);
      assert.match(result.reason ?? "", /duplicate-pi-session-conflict/);
      assert.match(result.reason ?? "", /piSessionId=pi-dup/);
      assert.match(result.reason ?? "", /cwd=\/work\/a/);
      assert.match(result.reason ?? "", /cwd=\/work\/b/);
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
      const expiredByPi = await sender.send({ piSessionId: "pi-ttl" }, { text: "expired-pi" });
      assert.equal(expiredByPi.delivered, false);
      assert.equal(expiredByPi.reason, "Session not found");
      const expiredByAlias = await sender.send({ alias: "ttl" }, { text: "expired-alias" });
      assert.equal(expiredByAlias.delivered, false);
      assert.equal(expiredByAlias.reason, "Session not found");
      keptAlive.heartbeat();
      await wait(120);
      const alive = await sender.send({ piSessionId: "pi-alive" }, { text: "heartbeat-kept-alive" });
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
      const result = await sender.send({ alias: "same" }, { text: "ambiguous-team" });
      assert.equal(result.delivered, false);
      assert.match(result.reason ?? "", /ambiguous-target/);
      assert.match(result.reason ?? "", /piSessionId=pi-a/);
      assert.match(result.reason ?? "", /piSessionId=pi-b/);
      assert.match(result.reason ?? "", /namespace=team/);
      assert.match(result.reason ?? "", /leaseExpiresAt=/);
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
      const result = await sender.send({ alias: "exact-alias" }, { text: "alias-field-hit" });
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
      const local = await sender.send({ alias: "cross" }, { text: "namespace-default" });
      assert.equal(local.delivered, true);
      await waitForReceivedMessage(inboxA.messages, "namespace-default");
      assert.equal(inboxB.messages.some((message) => message.content.text === "namespace-default"), false);

      const global = await sender.send({ alias: "cross", global: true }, { text: "global-ambiguous" });
      assert.equal(global.delivered, false);
      assert.match(global.reason ?? "", /ambiguous-target/);
      assert.match(global.reason ?? "", /namespace=team-a/);
      assert.match(global.reason ?? "", /namespace=team-b/);

      const exact = await sender.send({ intercomSessionId: targetB.sessionId ?? undefined, alias: "cross" }, { text: "exact-global" });
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
