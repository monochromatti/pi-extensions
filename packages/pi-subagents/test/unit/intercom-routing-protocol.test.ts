import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { IntercomClient } from "../../src/intercom-public/broker/client.ts";
import type { Message, SendTargetEnvelope } from "../../src/intercom-public/types.ts";

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
  name: string;
  piSessionId: string;
  namespace?: string;
  cwd?: string;
}): Promise<IntercomClient> {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  const client = new IntercomClient();
  try {
    await client.connect({
      name: session.name,
      piSessionId: session.piSessionId,
      protocolVersion: 2,
      capabilities: ["piSessionId-routing"],
      namespace: session.namespace,
      cwd: session.cwd ?? `/tmp/${session.name}`,
      model: "test-model",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
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

test("1.1/1.2 broker routes duplicate names by exact intercomSessionId", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const targetA = await connectClient(homeDir, { name: "dup", piSessionId: "pi-a", cwd: "/work/a" });
    const targetB = await connectClient(homeDir, { name: "dup", piSessionId: "pi-b", cwd: "/work/b" });
    const sender = await connectClient(homeDir, { name: "sender", piSessionId: "pi-sender", cwd: "/work/sender" });
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

test("1.3/1.4 broker structured target falls back from stale intercomSessionId to piSessionId", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const target = await connectClient(homeDir, { name: "supervisor", piSessionId: "pi-parent", cwd: "/work/parent" });
    const sender = await connectClient(homeDir, { name: "child", piSessionId: "pi-child", cwd: "/work/child" });
    const inbox = createInbox(target);

    try {
      const result = await sender.send({
        intercomSessionId: "stale-id",
        piSessionId: "pi-parent",
        alias: "supervisor",
      }, {
        text: "fallback-by-pi-session-id",
      });

      assert.equal(result.delivered, true);
      const received = await waitForReceivedMessage(inbox.messages, "fallback-by-pi-session-id");
      assert.equal(received.content.text, "fallback-by-pi-session-id");
    } finally {
      inbox.dispose();
      await disconnectAll([sender, target]);
    }
  });
});

test("3.1/3.2 structured sends include resolved receiver metadata; manual sends still deliver without requiring metadata", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const target = await connectClient(homeDir, { name: "receiver", piSessionId: "pi-receiver", cwd: "/work/receiver" });
    const sender = await connectClient(homeDir, { name: "sender", piSessionId: "pi-sender", cwd: "/work/sender" });
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

test("1.5/1.6 duplicate manual names return deterministic candidate error", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const targetA = await connectClient(homeDir, { name: "worker", piSessionId: "pi-worker-a", cwd: "/repo/a" });
    const targetB = await connectClient(homeDir, { name: "worker", piSessionId: "pi-worker-b", cwd: "/repo/b" });
    const sender = await connectClient(homeDir, { name: "sender", piSessionId: "pi-sender" });
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

test("1.7/1.8 namespace constrains alias lookup, exact IDs ignore namespace", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const targetA = await connectClient(homeDir, {
      name: "dupe",
      piSessionId: "pi-a",
      namespace: "team-a",
      cwd: "/repo/team-a",
    });
    const targetB = await connectClient(homeDir, {
      name: "dupe",
      piSessionId: "pi-b",
      namespace: "team-b",
      cwd: "/repo/team-b",
    });
    const sender = await connectClient(homeDir, { name: "sender", piSessionId: "pi-sender" });
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
      const miss = await sender.send(namespaceMiss, { text: "must-not-global-fallback" });
      assert.equal(miss.delivered, false);
      assert.equal(miss.reason, "Session not found");
      assert.equal(inboxA.messages.some((message) => message.content.text === "must-not-global-fallback"), false);
      assert.equal(inboxB.messages.some((message) => message.content.text === "must-not-global-fallback"), false);
    } finally {
      inboxA.dispose();
      inboxB.dispose();
      await disconnectAll([sender, targetA, targetB]);
    }
  });
});

test("1.9/1.10 protocol v2 keeps manual list + unique name send behavior", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const alpha = await connectClient(homeDir, { name: "alpha", piSessionId: "pi-alpha", cwd: "/repo/alpha" });
    const beta = await connectClient(homeDir, { name: "beta", piSessionId: "pi-beta", cwd: "/repo/beta" });
    const inbox = createInbox(beta);

    try {
      const sessions = await alpha.listSessions();
      const betaInList = sessions.find((session) => session.name === "beta");
      assert.ok(betaInList);
      assert.equal(betaInList.piSessionId, "pi-beta");
      assert.equal(betaInList.protocolVersion, 2);
      assert.deepEqual(betaInList.capabilities, ["piSessionId-routing"]);

      const send = await alpha.send("beta", { text: "manual-unique-name-still-works" });
      assert.equal(send.delivered, true);
      await waitForReceivedMessage(inbox.messages, "manual-unique-name-still-works");
    } finally {
      inbox.dispose();
      await disconnectAll([alpha, beta]);
    }
  });
});

test("1.11/1.12 session readiness + subagent metadata roundtrip via registration/presence", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    const child = new IntercomClient();
    const observer = new IntercomClient();
    try {
      await child.connect({
        name: "child",
        piSessionId: "pi-child",
        protocolVersion: 2,
        capabilities: ["piSessionId-routing"],
        cwd: "/repo/child",
        model: "child-model",
        pid: process.pid,
        startedAt: Date.now(),
        lastActivity: Date.now(),
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
        name: "observer",
        piSessionId: "pi-observer",
        protocolVersion: 2,
        capabilities: ["piSessionId-routing"],
        cwd: "/repo/observer",
        model: "observer-model",
        pid: process.pid,
        startedAt: Date.now(),
        lastActivity: Date.now(),
        status: "idle",
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }

    try {
      const listed = (await observer.listSessions()).find((session) => session.name === "child");
      assert.ok(listed);
      assert.equal(listed.readiness?.state, "initializing");
      assert.equal(listed.subagent?.ownerPiSessionId, "pi-parent");
      assert.equal(listed.subagent?.runId, "run-123");
      assert.equal(listed.subagent?.agent, "worker");
      assert.equal(listed.subagent?.index, 0);

      child.updatePresence({ readiness: { state: "ready", updatedAt: Date.now() } });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const refreshed = (await observer.listSessions()).find((session) => session.name === "child");
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

test("1.10 legacy registration receives protocol defaults", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    const legacy = new IntercomClient();
    const observer = new IntercomClient();
    try {
      await legacy.connect({
        name: "legacy",
        cwd: "/repo/legacy",
        model: "old-model",
        pid: process.pid,
        startedAt: Date.now(),
        lastActivity: Date.now(),
      });
      await observer.connect({
        name: "observer",
        piSessionId: "pi-observer",
        protocolVersion: 2,
        capabilities: ["piSessionId-routing"],
        cwd: "/repo/observer",
        model: "test-model",
        pid: process.pid,
        startedAt: Date.now(),
        lastActivity: Date.now(),
      });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }

    try {
      const legacyInList = (await observer.listSessions()).find((session) => session.name === "legacy");
      assert.ok(legacyInList);
      assert.equal(legacyInList.protocolVersion, 1);
      assert.deepEqual(legacyInList.capabilities, []);
      assert.equal(legacyInList.piSessionId, `legacy:${legacyInList.id}`);
    } finally {
      await disconnectAll([observer, legacy]);
    }
  });
});
