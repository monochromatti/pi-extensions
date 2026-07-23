import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import registerIntercomExtension, {
  createIntercomExtension,
  type IntercomRuntimeScheduler,
} from "../../src/intercom-public/index.ts";
import { IntercomClient } from "../../src/intercom-public/broker/client.ts";
import { type Message, type SessionInfo } from "../../src/intercom-public/types.ts";
import { getIntercomSupervisorTargetResolver } from "../../src/intercom-public/supervisor-target-resolver.ts";

const packageDir = process.cwd().endsWith(path.join("packages", "pi-subagents"))
  ? process.cwd()
  : path.join(process.cwd(), "packages/pi-subagents");
const repoDir = path.dirname(path.dirname(packageDir));

interface CapturedToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  details?: Record<string, unknown>;
}

interface CapturedTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<CapturedToolResult>;
}

type EventHandler = (event: unknown, ctx: IntercomTestContext) => unknown | Promise<unknown>;

interface IntercomTestContext {
  cwd: string;
  hasUI: boolean;
  isIdle: () => boolean;
  model: { id: string };
  sessionManager: {
    getSessionId: () => string;
  };
  ui: {
    notify: () => void;
    confirm: () => Promise<boolean>;
    custom: () => Promise<undefined>;
    setWidget: () => void;
    setToolsExpanded: () => void;
  };
}

class ManualScheduler implements IntercomRuntimeScheduler {
  private nextTimerId = 1;
  private readonly queue: Array<{ id: number; callback: () => void }> = [];

  setTimeout(callback: () => void, _delayMs: number): unknown {
    const id = this.nextTimerId++;
    this.queue.push({ id, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    const id = typeof handle === "number" ? handle : Number(handle);
    const index = this.queue.findIndex((entry) => entry.id === id);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }
  }

  pendingCount(): number {
    return this.queue.length;
  }

  runAll(): void {
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      next?.callback();
    }
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(assertion: () => boolean | Promise<boolean>, message: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await assertion()) return;
    await wait(25);
  }
  throw new Error(message);
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
  const sharedHome = mkdtempSync(path.join(tmpdir(), "pi-subagents-runtime-home-"));
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

function createContext(sessionId: string, options: { idle?: boolean; cwd?: string; hasUI?: boolean } = {}): IntercomTestContext {
  return {
    cwd: options.cwd ?? `/work/${sessionId}`,
    hasUI: options.hasUI ?? false,
    isIdle: () => options.idle ?? true,
    model: { id: "test-model" },
    sessionManager: {
      getSessionId: () => sessionId,
    },
    ui: {
      notify: () => undefined,
      confirm: async () => true,
      custom: async () => undefined,
      setWidget: () => undefined,
      setToolsExpanded: () => undefined,
    },
  };
}

function text(result: CapturedToolResult): string {
  return result.content.map((part) => part.text).join("\n");
}

async function createIntercomHarness(sessionName = "runtime-host", options: {
  register?: (pi: Parameters<typeof registerIntercomExtension>[0]) => void;
} = {}) {
  const tools = new Map<string, CapturedTool>();
  const handlers = new Map<string, EventHandler[]>();
  const sentMessages: Array<{ message: { content?: string; details?: unknown }; sendOptions?: unknown }> = [];
  const appendEntries: Array<{ type: string; payload: unknown }> = [];

  const eventSubscriptions = new Map<string, Set<(payload: unknown) => void>>();

  const hostPi = {
    registerTool(tool) {
      tools.set(tool.name, tool as CapturedTool);
    },
    on(name, handler) {
      const existing = handlers.get(name) ?? [];
      existing.push(handler as EventHandler);
      handlers.set(name, existing);
    },
    registerMessageRenderer() {
      return undefined;
    },
    events: {
      on(name: string, handler: (payload: unknown) => void) {
        const set = eventSubscriptions.get(name) ?? new Set();
        set.add(handler);
        eventSubscriptions.set(name, set);
        return () => set.delete(handler);
      },
      emit(name: string, payload: unknown) {
        for (const handler of eventSubscriptions.get(name) ?? []) {
          handler(payload);
        }
      },
    },
    sendMessage(message: { content?: string; details?: unknown }, sendOptions?: unknown) {
      sentMessages.push({ message, sendOptions });
      return undefined;
    },
    appendEntry(type: string, payload: unknown) {
      appendEntries.push({ type, payload });
      return undefined;
    },
    getSessionName() {
      return sessionName;
    },
  } as unknown as Parameters<typeof registerIntercomExtension>[0];

  (options.register ?? registerIntercomExtension)(hostPi);

  const emit = async (name: string, ctx: IntercomTestContext) => {
    for (const handler of handlers.get(name) ?? []) {
      await handler({ type: name }, ctx);
    }
  };

  const tool = (name: string): CapturedTool => {
    const found = tools.get(name);
    assert.ok(found, `Missing tool ${name}`);
    return found;
  };

  const emitEvent = (name: string, payload: unknown) => {
    for (const handler of eventSubscriptions.get(name) ?? []) {
      handler(payload);
    }
  };

  return { emit, emitEvent, tool, sentMessages, appendEntries, hostPi };
}

function parseSessionIdFromStatus(result: CapturedToolResult): string {
  const match = text(result).match(/Session ID: (.+)/);
  assert.ok(match, `Unable to parse session id from status: ${text(result)}`);
  return match[1]!.trim();
}


test("leak regression: unrelated machine ask only displays on addressed target across namespaces", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    const receiver = await createIntercomHarness("same-alias");
    const machine = new IntercomClient();
    const ctxA = createContext("pi-session-a", { idle: true, cwd: "/repo/a", hasUI: true });
    const ctxB = createContext("pi-session-b", { idle: true, cwd: "/repo/b", hasUI: true });
    try {
      await receiver.emit("session_start", ctxA);
      const statusA = await receiver.tool("intercom").execute("status-a", { action: "status" }, new AbortController().signal, undefined, ctxA);
      const intercomSessionA = parseSessionIdFromStatus(statusA);
      await receiver.emit("session_start", ctxB);
      await receiver.tool("intercom").execute("status-b", { action: "status" }, new AbortController().signal, undefined, ctxB);
      await machine.connect({
        alias: "machine",
        piSessionId: "pi-machine",
        namespace: "test-namespace",
        cwd: "/repo/machine",
        model: "test-model",
        pid: process.pid,
        startedAt: Date.now(),
        lastActivity: Date.now(),
        leaseTtlMs: 30_000,
        heartbeatIntervalMs: 10_000,
      });
      const sent = await machine.sendMachine({
        kind: "identity-snapshot",
        intercomSessionId: intercomSessionA,
        piSessionId: "pi-session-a",
        reconnect: "same-pi-session-if-unique",
      }, {
        text: "machine-for-a-only",
        expectsReply: true,
      });
      assert.equal(sent.delivered, true);
      await waitUntil(async () => /machine-for-a-only/.test(text(await receiver.tool("intercom").execute("pending-a", { action: "pending" }, new AbortController().signal, undefined, ctxA))), "A did not receive machine ask");
      assert.doesNotMatch(text(await receiver.tool("intercom").execute("pending-b", { action: "pending" }, new AbortController().signal, undefined, ctxB)), /machine-for-a-only/);
      assert.equal(receiver.sentMessages.some((entry) => entry.message.content?.includes("machine-for-a-only")), false);
    } finally {
      await machine.disconnect().catch(() => undefined);
      await receiver.emit("session_shutdown", ctxA);
      await receiver.emit("session_shutdown", ctxB);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  });
});

test("session-scoped runtime keeps inbox isolated after later session start", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    const receiver = await createIntercomHarness("receiver-host");
    const sender = new IntercomClient();

    const ctxA = createContext("pi-session-a", { idle: true, cwd: "/repo/a" });
    const ctxB = createContext("pi-session-b", { idle: true, cwd: "/repo/b" });

    try {
      await receiver.emit("session_start", ctxA);
      const statusA = await receiver.tool("intercom").execute("status-a", { action: "status" }, new AbortController().signal, undefined, ctxA);
      assert.equal(statusA.isError, false);
      const intercomSessionA = parseSessionIdFromStatus(statusA);

      await receiver.emit("session_start", ctxB);
      const statusB = await receiver.tool("intercom").execute("status-b", { action: "status" }, new AbortController().signal, undefined, ctxB);
      assert.equal(statusB.isError, false);
      assert.notEqual(parseSessionIdFromStatus(statusB), intercomSessionA);
      await receiver.emit("turn_start", ctxB);

      await sender.connect({
        alias: "sender",
        piSessionId: "pi-sender",
        namespace: "test-namespace",
        cwd: "/repo/sender",
        model: "test-model",
        pid: process.pid,
        startedAt: Date.now(),
        lastActivity: Date.now(),
        leaseTtlMs: 30_000,
        heartbeatIntervalMs: 10_000,
      });

      const sent = await sender.sendManual({ kind: "intercom-session", intercomSessionId: intercomSessionA }, {
        text: "question-for-a",
        expectsReply: true,
      });
      assert.equal(sent.delivered, true);

      await waitUntil(async () => {
        const pendingA = await receiver.tool("intercom").execute("pending-a", { action: "pending" }, new AbortController().signal, undefined, ctxA);
        return /question-for-a/.test(text(pendingA));
      }, "session A did not record inbound ask");

      const pendingB = await receiver.tool("intercom").execute("pending-b", { action: "pending" }, new AbortController().signal, undefined, ctxB);
      assert.match(text(pendingB), /No unresolved inbound asks/);
      assert.equal(
        receiver.sentMessages.some((entry) => entry.message.content?.includes("question-for-a")),
        false,
      );

      // Lifecycle activity for either session cannot make shared, unscoped
      // ExtensionAPI.sendMessage safe while both runtimes exist.
      await receiver.emit("turn_start", ctxA);
      const secondA = await sender.sendManual({ kind: "intercom-session", intercomSessionId: intercomSessionA }, {
        text: "second-question-for-a",
        expectsReply: true,
      });
      const sentB = await sender.sendManual({ kind: "intercom-session", intercomSessionId: parseSessionIdFromStatus(statusB) }, {
        text: "question-for-b",
        expectsReply: true,
      });
      assert.equal(secondA.delivered, true);
      assert.equal(sentB.delivered, true);
      await waitUntil(async () => {
        const a = text(await receiver.tool("intercom").execute("pending-a-2", { action: "pending" }, new AbortController().signal, undefined, ctxA));
        const b = text(await receiver.tool("intercom").execute("pending-b-2", { action: "pending" }, new AbortController().signal, undefined, ctxB));
        return /second-question-for-a/.test(a) && /question-for-b/.test(b);
      }, "both runtimes did not record suppressed asks");
      assert.equal(receiver.sentMessages.some((entry) =>
        entry.message.content?.includes("second-question-for-a") || entry.message.content?.includes("question-for-b")), false);

      // Suppressed host deliveries must not leave hidden turn context. With two
      // pending asks, reply without replyTo must remain ambiguous.
      await receiver.emit("session_shutdown", ctxB);
      await receiver.emit("turn_start", ctxA);
      const ambiguousReply = await receiver.tool("intercom").execute("reply-after-suppression", {
        action: "reply",
        message: "must-not-guess",
      }, new AbortController().signal, undefined, ctxA);
      assert.equal(ambiguousReply.isError, true);
      assert.match(text(ambiguousReply), /Multiple pending asks.*replyTo/s);
    } finally {
      await sender.disconnect().catch(() => undefined);
      await receiver.emit("session_shutdown", ctxA);
      await receiver.emit("session_shutdown", ctxB);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  });
});

test("tool execution resolves runtime from execution context, not latest runtime", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    const receiver = await createIntercomHarness("runtime-host");
    const ctxA = createContext("pi-session-a", { idle: true, cwd: "/repo/a" });
    const ctxB = createContext("pi-session-b", { idle: true, cwd: "/repo/b" });

    try {
      await receiver.emit("session_start", ctxA);
      const statusA = await receiver.tool("intercom").execute("status-a", { action: "status" }, new AbortController().signal, undefined, ctxA);
      const intercomSessionA = parseSessionIdFromStatus(statusA);

      await receiver.emit("session_start", ctxB);
      const statusB = await receiver.tool("intercom").execute("status-b", { action: "status" }, new AbortController().signal, undefined, ctxB);
      const intercomSessionB = parseSessionIdFromStatus(statusB);
      assert.notEqual(intercomSessionA, intercomSessionB);

      await receiver.emit("turn_start", ctxB);

      const statusAAfterBTurn = await receiver.tool("intercom").execute("status-a-after", { action: "status" }, new AbortController().signal, undefined, ctxA);
      assert.equal(parseSessionIdFromStatus(statusAAfterBTurn), intercomSessionA);
    } finally {
      await receiver.emit("session_shutdown", ctxA);
      await receiver.emit("session_shutdown", ctxB);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  });
});

test("inbound broker callbacks stay bound to owning runtime instance", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    const receiver = await createIntercomHarness("runtime-host");
    const sender = new IntercomClient();
    const ctxA = createContext("pi-session-a", { idle: true, cwd: "/repo/a" });
    const ctxB = createContext("pi-session-b", { idle: true, cwd: "/repo/b" });

    try {
      await receiver.emit("session_start", ctxA);
      const statusA = await receiver.tool("intercom").execute("status-a", { action: "status" }, new AbortController().signal, undefined, ctxA);
      const intercomSessionA = parseSessionIdFromStatus(statusA);

      await receiver.emit("session_start", ctxB);
      const statusB = await receiver.tool("intercom").execute("status-b", { action: "status" }, new AbortController().signal, undefined, ctxB);
      const intercomSessionB = parseSessionIdFromStatus(statusB);
      assert.notEqual(intercomSessionA, intercomSessionB);

      await receiver.emit("turn_start", ctxA);

      await sender.connect({
        alias: "sender",
        piSessionId: "pi-sender",
        namespace: "test-namespace",
        cwd: "/repo/sender",
        model: "test-model",
        pid: process.pid,
        startedAt: Date.now(),
        lastActivity: Date.now(),
        leaseTtlMs: 30_000,
        heartbeatIntervalMs: 10_000,
      });

      const sent = await sender.sendManual({ kind: "intercom-session", intercomSessionId: intercomSessionB }, {
        text: "ask-for-session-b",
        expectsReply: true,
      });
      assert.equal(sent.delivered, true);

      await waitUntil(async () => {
        const pendingB = await receiver.tool("intercom").execute("pending-b", { action: "pending" }, new AbortController().signal, undefined, ctxB);
        return /ask-for-session-b/.test(text(pendingB));
      }, "session B did not record its inbound ask");

      const pendingA = await receiver.tool("intercom").execute("pending-a", { action: "pending" }, new AbortController().signal, undefined, ctxA);
      assert.match(text(pendingA), /No unresolved inbound asks/);
    } finally {
      await sender.disconnect().catch(() => undefined);
      await receiver.emit("session_shutdown", ctxA);
      await receiver.emit("session_shutdown", ctxB);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  });
});

test("replaced runtime drops delayed inbound flush from old runtime", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    const scheduler = new ManualScheduler();
    const receiver = await createIntercomHarness("runtime-host", {
      register: createIntercomExtension({ schedulerFactory: () => scheduler }),
    });
    const sender = new IntercomClient();
    const ctxOld = createContext("pi-session-a", { idle: false, hasUI: true, cwd: "/repo/a" });
    const ctxReplacement = createContext("pi-session-a", { idle: true, hasUI: true, cwd: "/repo/a-replacement" });

    try {
      await receiver.emit("session_start", ctxOld);
      const statusOld = await receiver.tool("intercom").execute("status-old", { action: "status" }, new AbortController().signal, undefined, ctxOld);
      const intercomSessionA = parseSessionIdFromStatus(statusOld);

      scheduler.runAll();

      await sender.connect({
        alias: "sender",
        piSessionId: "pi-sender",
        namespace: "test-namespace",
        cwd: "/repo/sender",
        model: "test-model",
        pid: process.pid,
        startedAt: Date.now(),
        lastActivity: Date.now(),
        leaseTtlMs: 30_000,
        heartbeatIntervalMs: 10_000,
      });

      const sent = await sender.sendManual({ kind: "intercom-session", intercomSessionId: intercomSessionA }, {
        text: "race-message-old-runtime",
        expectsReply: true,
      });
      assert.equal(sent.delivered, true);

      await waitUntil(() => scheduler.pendingCount() > 0, "expected delayed inbound flush timer");

      await receiver.emit("session_start", ctxReplacement);
      scheduler.runAll();

      assert.equal(
        receiver.sentMessages.some((entry) => entry.message.content?.includes("race-message-old-runtime")),
        false,
      );
      const pending = await receiver.tool("intercom").execute("pending-replacement", { action: "pending" }, new AbortController().signal, undefined, ctxReplacement);
      assert.match(text(pending), /No unresolved inbound asks/);
    } finally {
      await sender.disconnect().catch(() => undefined);
      await receiver.emit("session_shutdown", ctxReplacement);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  });
});

test("result relay enforces owner session and ignores non-owner runtime B", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    const receiver = await createIntercomHarness("runtime-host");
    const ctxA = createContext("pi-session-a", { idle: true, cwd: "/repo/a" });
    const ctxB = createContext("pi-session-b", { idle: true, cwd: "/repo/b" });

    try {
      await receiver.emit("session_start", ctxA);
      await receiver.tool("intercom").execute("status-a", { action: "status" }, new AbortController().signal, undefined, ctxA);

      await receiver.emit("session_start", ctxB);
      await receiver.tool("intercom").execute("status-b", { action: "status" }, new AbortController().signal, undefined, ctxB);

      receiver.emitEvent("subagent:result-intercom", {
        ownerPiSessionId: "pi-session-a",
        target: { kind: "scoped-alias", alias: "pi-session-b", namespace: "test-namespace" },
        to: "pi-session-b",
        message: "result-owner-a-not-b",
        requestId: "result-owner-a-not-b",
      });

      await wait(250);

      assert.equal(
        receiver.sentMessages.some((entry) => entry.message.content?.includes("result-owner-a-not-b")),
        false,
      );

      await receiver.emit("session_shutdown", ctxA);

      const acknowledgements: Array<{ requestId?: unknown; delivered?: unknown }> = [];
      const unsubscribe = receiver.hostPi.events.on("subagent:result-intercom-delivery", (payload) => {
        acknowledgements.push(payload as { requestId?: unknown; delivered?: unknown });
      });

      receiver.emitEvent("subagent:result-intercom", {
        target: { kind: "scoped-alias", alias: "pi-session-b", namespace: "test-namespace" },
        to: "pi-session-b",
        message: "result-missing-owner-must-drop",
        requestId: "result-missing-owner-must-drop",
      });

      await wait(250);
      unsubscribe();

      assert.equal(
        receiver.sentMessages.some((entry) => entry.message.content?.includes("result-missing-owner-must-drop")),
        false,
      );
      assert.equal(
        acknowledgements.some((entry) => entry.requestId === "result-missing-owner-must-drop"),
        false,
      );
    } finally {
      await receiver.emit("session_shutdown", ctxB);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  });
});

test("control relay enforces owner session and ignores non-owner runtime B", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    const receiver = await createIntercomHarness("runtime-host");
    const ctxA = createContext("pi-session-a", { idle: true, cwd: "/repo/a" });
    const ctxB = createContext("pi-session-b", { idle: true, cwd: "/repo/b" });

    try {
      await receiver.emit("session_start", ctxA);
      await receiver.tool("intercom").execute("status-a", { action: "status" }, new AbortController().signal, undefined, ctxA);

      await receiver.emit("session_start", ctxB);
      await receiver.tool("intercom").execute("status-b", { action: "status" }, new AbortController().signal, undefined, ctxB);

      receiver.emitEvent("subagent:control-intercom", {
        ownerPiSessionId: "pi-session-a",
        target: { kind: "scoped-alias", alias: "pi-session-b", namespace: "test-namespace" },
        to: "pi-session-b",
        message: "control-owner-a-not-b",
      });

      await wait(250);
      assert.equal(
        receiver.sentMessages.some((entry) => entry.message.content?.includes("control-owner-a-not-b")),
        false,
      );

      await receiver.emit("session_shutdown", ctxA);

      receiver.emitEvent("subagent:control-intercom", {
        target: { kind: "scoped-alias", alias: "pi-session-b", namespace: "test-namespace" },
        to: "pi-session-b",
        message: "control-missing-owner-must-drop",
      });

      await wait(250);
      assert.equal(
        receiver.sentMessages.some((entry) => entry.message.content?.includes("control-missing-owner-must-drop")),
        false,
      );
    } finally {
      await receiver.emit("session_shutdown", ctxB);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  });
});

test("result relay does not deliver before child readiness and times out", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    const receiver = await createIntercomHarness("runtime-host");
    const ctxA = createContext("pi-session-a", { idle: true, cwd: "/repo/a" });
    const child = new IntercomClient();
    const childMessages: Message[] = [];

    try {
      await receiver.emit("session_start", ctxA);
      await receiver.tool("intercom").execute("status-a", { action: "status" }, new AbortController().signal, undefined, ctxA);

      child.on("message", (_from: SessionInfo, message: Message) => {
        childMessages.push(message);
      });

      await child.connect({
        alias: "subagent-worker-run-readiness-timeout-1",
        piSessionId: "child-pi-session",
        namespace: "test-namespace",
        cwd: "/repo/child",
        model: "test-model",
        pid: process.pid,
        startedAt: Date.now(),
        lastActivity: Date.now(),
        leaseTtlMs: 30_000,
        heartbeatIntervalMs: 10_000,
        status: "idle",
        readiness: { state: "initializing", updatedAt: Date.now() },
        subagent: {
          ownerPiSessionId: "pi-session-a",
          runId: "run-readiness-timeout",
          agent: "worker",
          index: 0,
        },
      });

      const deliveries: Array<{ requestId?: unknown; delivered?: unknown }> = [];
      const unsubscribe = receiver.hostPi.events.on("subagent:result-intercom-delivery", (payload) => {
        deliveries.push(payload as { requestId?: unknown; delivered?: unknown });
      });

      receiver.emitEvent("subagent:result-intercom", {
        ownerPiSessionId: "pi-session-a",
        target: { kind: "scoped-alias", alias: "subagent-worker-run-readiness-timeout-1", namespace: "test-namespace" },
        message: "should-not-deliver-before-ready",
        requestId: "readiness-timeout",
        runId: "run-readiness-timeout",
        agent: "worker",
        index: 0,
        waitForReadyMs: 100,
      });

      await waitUntil(
        () => deliveries.some((entry) => entry.requestId === "readiness-timeout"),
        "expected delivery acknowledgement for readiness timeout",
      );

      receiver.emitEvent("subagent:result-intercom", {
        ownerPiSessionId: "pi-session-a",
        target: { kind: "scoped-alias", alias: "subagent-worker-run-readiness-timeout-1", namespace: "test-namespace" },
        message: "should-not-deliver-before-ready-zero-wait",
        requestId: "readiness-timeout-zero",
        runId: "run-readiness-timeout",
        agent: "worker",
        index: 0,
        waitForReadyMs: 0,
      });

      await waitUntil(
        () => deliveries.some((entry) => entry.requestId === "readiness-timeout-zero"),
        "expected delivery acknowledgement for zero-wait readiness timeout",
      );
      unsubscribe();

      const delivery = deliveries.find((entry) => entry.requestId === "readiness-timeout");
      assert.ok(delivery, "expected readiness-timeout delivery acknowledgement");
      assert.equal(delivery?.delivered, false);

      const deliveryZero = deliveries.find((entry) => entry.requestId === "readiness-timeout-zero");
      assert.ok(deliveryZero, "expected readiness-timeout-zero delivery acknowledgement");
      assert.equal(deliveryZero?.delivered, false);

      assert.equal(
        childMessages.some((message) => message.content.text.includes("should-not-deliver-before-ready")),
        false,
      );
      assert.equal(
        childMessages.some((message) => message.content.text.includes("should-not-deliver-before-ready-zero-wait")),
        false,
      );
    } finally {
      await child.disconnect().catch(() => undefined);
      await receiver.emit("session_shutdown", ctxA);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  });
});

test("getSupervisorTarget rejects unsafe routing when broker self piSessionId mismatches runtime session", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    const harness = await createIntercomHarness("runtime-host");
    const ctx = createContext("pi-session-a", { idle: true, cwd: "/repo/a" });
    const originalListSessions = IntercomClient.prototype.listSessions;
    IntercomClient.prototype.listSessions = async function patchedListSessions(this: IntercomClient) {
      const sessions = await originalListSessions.call(this);
      return sessions.map((session) => session.id === this.sessionId
        ? { ...session, piSessionId: "wrong-pi-session" }
        : session);
    };

    try {
      await harness.emit("session_start", ctx);
      const resolver = getIntercomSupervisorTargetResolver(harness.hostPi as never);
      assert.ok(resolver, "supervisor target resolver should be registered");

      await assert.rejects(
        () => resolver!.getSupervisorTarget(ctx.sessionManager.getSessionId()),
        /unsafe supervisor routing|mismatch/i,
      );
    } finally {
      IntercomClient.prototype.listSessions = originalListSessions;
      await harness.emit("session_shutdown", ctx);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  });
});

test("intercom list shows exact identity, namespace, cwd, and lease state", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    const harness = await createIntercomHarness("runtime-host");
    const ctx = createContext("pi-session-a", { cwd: "/repo/a" });
    try {
      await harness.emit("session_start", ctx);
      const list = await harness.tool("intercom").execute("list-identity", { action: "list" }, new AbortController().signal, undefined, ctx);
      const output = text(list);
      assert.match(output, /Current session:/);
      assert.match(output, /runtime-host/);
      assert.match(output, /piSessionId=pi-session-a/);
      assert.match(output, /intercomSessionId=/);
      assert.match(output, /namespace=[a-f0-9]{16}/);
      assert.match(output, /lease=active/);
      assert.match(output, /\/repo\/a/);
      assert.equal((list.details as { currentSession?: { piSessionId?: unknown; namespace?: unknown; leaseState?: unknown } }).currentSession?.piSessionId, "pi-session-a");
      assert.equal(typeof (list.details as { currentSession?: { namespace?: unknown } }).currentSession?.namespace, "string");
      assert.match(String((list.details as { currentSession?: { leaseState?: unknown } }).currentSession?.leaseState), /lease=active/);
    } finally {
      await harness.emit("session_shutdown", ctx);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  });
});

test("manual send by original alias still routes after status/model/readiness updates", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    const createdClients = new Map<string, IntercomClient>();
    const originalConnect = IntercomClient.prototype.connect;
    IntercomClient.prototype.connect = async function capturedConnect(this: IntercomClient, session) {
      createdClients.set(session.piSessionId, this);
      return originalConnect.call(this, session);
    };

    const sender = await createIntercomHarness("sender-alias");
    const receiver = await createIntercomHarness("receiver-alias");
    const senderCtx = createContext("pi-sender", { idle: true, cwd: "/repo/shared", hasUI: true });
    const receiverCtx = createContext("pi-receiver", { idle: true, cwd: "/repo/shared", hasUI: true });

    try {
      await sender.emit("session_start", senderCtx);
      await receiver.emit("session_start", receiverCtx);
      await waitUntil(() => createdClients.has("pi-receiver"), "receiver intercom client not created");

      const receiverClient = createdClients.get("pi-receiver")!;
      receiverClient.updatePresence({ status: "thinking" });
      receiverClient.updatePresence({ model: "receiver-model-v2" });
      receiverClient.updatePresence({ readiness: { state: "ready", updatedAt: Date.now() } });

      const send = await sender.tool("intercom").execute("send-by-stable-alias", {
        action: "send",
        to: "receiver-alias",
        message: "manual-send-after-presence-updates",
      }, new AbortController().signal, undefined, senderCtx);

      assert.equal(send.isError, false);
      await waitUntil(
        () => receiver.sentMessages.some((entry) => entry.message.content?.includes("manual-send-after-presence-updates")),
        "manual send did not route to original alias",
      );
    } finally {
      IntercomClient.prototype.connect = originalConnect;
      await sender.emit("session_shutdown", senderCtx);
      await receiver.emit("session_shutdown", receiverCtx);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  });
});

test("manual string aliases are parsed to scoped/global structured targets before client send", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    const originalSendManual = IntercomClient.prototype.sendManual;
    const sendCalls: Array<{ to: unknown; options: Record<string, unknown> }> = [];
    IntercomClient.prototype.sendManual = async function capturedSendManual(this: IntercomClient, to, options) {
      sendCalls.push({ to, options: options as unknown as Record<string, unknown> });
      return originalSendManual.call(this, to, options);
    };

    const sender = await createIntercomHarness("sender-alias");
    const receiver = await createIntercomHarness("receiver-alias");
    const senderCtx = createContext("pi-sender", { idle: true, cwd: "/repo/shared", hasUI: true });
    const receiverCtx = createContext("pi-receiver", { idle: true, cwd: "/repo/shared", hasUI: true });

    try {
      await sender.emit("session_start", senderCtx);
      await receiver.emit("session_start", receiverCtx);

      const scopedSend = await sender.tool("intercom").execute("send-scoped-target", {
        action: "send",
        to: "receiver-alias",
        message: "manual-string-scoped-target",
      }, new AbortController().signal, undefined, senderCtx);
      assert.equal(scopedSend.isError, false);

      const globalSend = await sender.tool("intercom").execute("send-global-target", {
        action: "send",
        to: "global:receiver-alias",
        message: "manual-string-global-target",
      }, new AbortController().signal, undefined, senderCtx);
      assert.equal(globalSend.isError, false);

      await waitUntil(
        () => receiver.sentMessages.some((entry) => entry.message.content?.includes("manual-string-global-target")),
        "manual global send did not deliver",
      );

      const scopedCaptured = sendCalls.find((call) => call.options.text === "manual-string-scoped-target");
      assert.ok(scopedCaptured, "scoped manual send call not captured");
      const scopedTarget = scopedCaptured!.to as { kind?: unknown; alias?: unknown; namespace?: unknown };
      assert.equal(scopedTarget.kind, "scoped-alias");
      assert.equal(scopedTarget.alias, "receiver-alias");
      assert.equal(typeof scopedTarget.namespace, "string");
      assert.match(String(scopedTarget.namespace), /^[a-f0-9]{16}$/);

      const globalCaptured = sendCalls.find((call) => call.options.text === "manual-string-global-target");
      assert.ok(globalCaptured, "global manual send call not captured");
      const globalTarget = globalCaptured!.to as { kind?: unknown; alias?: unknown };
      assert.equal(globalTarget.kind, "global-alias");
      assert.equal(globalTarget.alias, "receiver-alias");
    } finally {
      IntercomClient.prototype.sendManual = originalSendManual;
      await sender.emit("session_shutdown", senderCtx);
      await receiver.emit("session_shutdown", receiverCtx);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  });
});

test("reply uses identity-snapshot structured target", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    const capturedTargets: unknown[] = [];
    const originalSendManual = IntercomClient.prototype.sendManual;
    IntercomClient.prototype.sendManual = async function capturedSendManual(this: IntercomClient, to, options) {
      if ((options as { replyTo?: unknown }).replyTo) {
        capturedTargets.push(to);
      }
      return originalSendManual.call(this, to, options);
    };

    const sender = await createIntercomHarness("sender-alias");
    const receiver = await createIntercomHarness("receiver-alias");
    const senderCtx = createContext("pi-sender", { idle: true, cwd: "/repo/shared", hasUI: true });
    const receiverCtx = createContext("pi-receiver", { idle: true, cwd: "/repo/shared", hasUI: true });

    try {
      await sender.emit("session_start", senderCtx);
      await receiver.emit("session_start", receiverCtx);

      const askPromise = sender.tool("intercom").execute("ask-target", {
        action: "ask",
        to: "receiver-alias",
        message: "question-for-reply-snapshot",
      }, new AbortController().signal, undefined, senderCtx);

      await waitUntil(
        () => receiver.sentMessages.some((entry) => entry.message.content?.includes("question-for-reply-snapshot")),
        "ask message was not delivered to receiver",
      );

      const deliveredPrompt = receiver.sentMessages.find((entry) => entry.message.content?.includes("question-for-reply-snapshot"));
      const inboundId = (deliveredPrompt?.message.details as { message?: { id?: string } } | undefined)?.message?.id;
      assert.ok(inboundId, "inbound message id missing");
      assert.match(deliveredPrompt?.message.content ?? "", new RegExp(`replyTo: "${inboundId}"`));

      const replied = await receiver.tool("intercom").execute("reply-target", {
        action: "reply",
        replyTo: inboundId,
        message: "reply-from-receiver",
      }, new AbortController().signal, undefined, receiverCtx);
      assert.equal(replied.isError, false);

      const asked = await askPromise;
      assert.equal(asked.isError, false);

      const captured = capturedTargets.find((target) => {
        if (typeof target !== "object" || target === null) return false;
        return (target as { kind?: unknown }).kind === "identity-snapshot";
      }) as { kind?: unknown; reconnect?: unknown } | undefined;
      assert.ok(captured, "identity-snapshot reply target not captured");
      assert.equal(captured?.kind, "identity-snapshot");
      assert.equal(captured?.reconnect, "same-pi-session-if-unique");
    } finally {
      IntercomClient.prototype.sendManual = originalSendManual;
      await sender.emit("session_shutdown", senderCtx);
      await receiver.emit("session_shutdown", receiverCtx);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  });
});

test("status shows identity diagnostics and resolution logs omit message bodies", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    const harness = await createIntercomHarness("runtime-host");
    const ctx = createContext("pi-session-a", { cwd: "/repo/a" });
    try {
      await harness.emit("session_start", ctx);
      const failed = await harness.tool("intercom").execute("send-missing", {
        action: "send",
        to: "missing-target",
        message: "SECRET BODY MUST NOT BE LOGGED",
        waitForReadyMs: 0,
      }, new AbortController().signal, undefined, ctx);
      assert.equal(failed.isError, true);
      assert.match(text(failed), /Message to "missing-target" was not delivered: Target session not found\./);
      assert.equal((failed.details as { failure?: { code?: unknown } }).failure?.code, "target-not-found");
      const status = await harness.tool("intercom").execute("status-after-failure", { action: "status" }, new AbortController().signal, undefined, ctx);
      const output = text(status);
      assert.match(output, /Pi session ID: pi-session-a/);
      assert.match(output, /Namespace: [a-f0-9]{16}/);
      assert.match(output, /Lease: lease=active/);
      assert.match(output, /Resolution failures: 1/);
      assert.match(output, /Recent resolution failures:\n- send target-not-found Target session not found\./);
      const resolutionEntry = harness.appendEntries.find((entry) => entry.type === "intercom_resolution_failed");
      assert.ok(resolutionEntry);
      assert.equal((resolutionEntry.payload as { failureCode?: unknown }).failureCode, "target-not-found");
      assert.doesNotMatch(JSON.stringify(resolutionEntry.payload), /SECRET BODY MUST NOT BE LOGGED/);
    } finally {
      await harness.emit("session_shutdown", ctx);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  });
});

test("mismatched receiver piSessionId is dropped before pending/UI delivery", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    const createdClients: IntercomClient[] = [];
    const originalConnect = IntercomClient.prototype.connect;
    IntercomClient.prototype.connect = async function capturedConnect(this: IntercomClient, session) {
      createdClients.push(this);
      return originalConnect.call(this, session);
    };

    const receiver = await createIntercomHarness("runtime-host");
    const ctx = createContext("pi-session-a", { idle: true, cwd: "/repo/a", hasUI: true });

    const from: SessionInfo = {
      id: "sender-session",
      piSessionId: "pi-sender",
      namespace: "test-namespace",
      alias: "sender",
      cwd: "/repo/sender",
      model: "test-model",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      leaseTtlMs: 30_000,
      heartbeatIntervalMs: 10_000,
      status: "idle",
    };

    try {
      await receiver.emit("session_start", ctx);
      await waitUntil(() => createdClients.length > 0, "runtime intercom client not created");

      const runtimeClient = createdClients[0]!;
      const inbound: Message = {
        id: "misroute-1",
        timestamp: Date.now(),
        to: {
          intercomSessionId: "other-intercom-session",
          piSessionId: "pi-session-b",
          alias: "other",
        },
        expectsReply: true,
        content: {
          text: "must-be-dropped",
        },
      };

      runtimeClient.emit("message", from, inbound);
      await wait(50);

      const pending = await receiver.tool("intercom").execute("pending-after-drop", { action: "pending" }, new AbortController().signal, undefined, ctx);
      assert.match(text(pending), /No unresolved inbound asks/);
      assert.equal(
        receiver.sentMessages.some((entry) => entry.message.content?.includes("must-be-dropped")),
        false,
      );
    } finally {
      IntercomClient.prototype.connect = originalConnect;
      await receiver.emit("session_shutdown", ctx);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  });
});

test("messages missing exact delivered receiver identity are dropped before pending/UI delivery", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    const createdClients: IntercomClient[] = [];
    const originalConnect = IntercomClient.prototype.connect;
    IntercomClient.prototype.connect = async function capturedConnect(this: IntercomClient, session) {
      createdClients.push(this);
      return originalConnect.call(this, session);
    };

    const receiver = await createIntercomHarness("runtime-host");
    const ctx = createContext("pi-session-a", { idle: true, cwd: "/repo/a", hasUI: true });

    const from: SessionInfo = {
      id: "sender-session",
      piSessionId: "pi-sender",
      namespace: "test-namespace",
      alias: "sender",
      cwd: "/repo/sender",
      model: "test-model",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      leaseTtlMs: 30_000,
      heartbeatIntervalMs: 10_000,
      status: "idle",
    };

    try {
      await receiver.emit("session_start", ctx);
      await waitUntil(() => createdClients.length > 0 && Boolean(createdClients[0]!.sessionId), "runtime intercom client not created");

      const runtimeClient = createdClients[0]!;
      runtimeClient.emit("message", from, {
        id: "missing-pi",
        timestamp: Date.now(),
        to: {
          intercomSessionId: runtimeClient.sessionId,
          alias: "runtime-host",
        },
        expectsReply: true,
        content: { text: "missing-pi-must-be-dropped" },
      } as never);
      runtimeClient.emit("message", from, {
        id: "missing-intercom",
        timestamp: Date.now(),
        to: {
          piSessionId: "pi-session-a",
          alias: "runtime-host",
        },
        expectsReply: true,
        content: { text: "missing-intercom-must-be-dropped" },
      } as never);
      await wait(50);

      const pending = await receiver.tool("intercom").execute("pending-after-missing-identity-drop", { action: "pending" }, new AbortController().signal, undefined, ctx);
      assert.match(text(pending), /No unresolved inbound asks/);
      assert.equal(
        receiver.sentMessages.some((entry) => entry.message.content?.includes("missing-pi-must-be-dropped") || entry.message.content?.includes("missing-intercom-must-be-dropped")),
        false,
      );
      const dropped = receiver.appendEntries.filter((entry) => entry.type === "intercom_misroute_dropped");
      assert.equal(dropped.some((entry) => (entry.payload as Record<string, unknown>).reason === "receiver_identity_missing"), true);
    } finally {
      IntercomClient.prototype.connect = originalConnect;
      await receiver.emit("session_shutdown", ctx);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  });
});

test("mismatched receiver intercomSessionId is dropped before pending/UI delivery", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    const createdClients: IntercomClient[] = [];
    const originalConnect = IntercomClient.prototype.connect;
    IntercomClient.prototype.connect = async function capturedConnect(this: IntercomClient, session) {
      createdClients.push(this);
      return originalConnect.call(this, session);
    };

    const receiver = await createIntercomHarness("runtime-host");
    const ctx = createContext("pi-session-a", { idle: true, cwd: "/repo/a", hasUI: true });

    const from: SessionInfo = {
      id: "sender-session",
      piSessionId: "pi-sender",
      namespace: "test-namespace",
      alias: "sender",
      cwd: "/repo/sender",
      model: "test-model",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      leaseTtlMs: 30_000,
      heartbeatIntervalMs: 10_000,
      status: "idle",
    };

    try {
      await receiver.emit("session_start", ctx);
      await waitUntil(() => createdClients.length > 0 && Boolean(createdClients[0]!.sessionId), "runtime intercom client not created");

      const runtimeClient = createdClients[0]!;
      runtimeClient.emit("message", from, {
        id: "misroute-intercom",
        timestamp: Date.now(),
        to: {
          intercomSessionId: "wrong-intercom-session",
          piSessionId: "pi-session-a",
          alias: "runtime-host",
        },
        expectsReply: true,
        content: { text: "wrong-intercom-must-be-dropped" },
      } satisfies Message);
      await wait(50);

      const pending = await receiver.tool("intercom").execute("pending-after-intercom-drop", { action: "pending" }, new AbortController().signal, undefined, ctx);
      assert.match(text(pending), /No unresolved inbound asks/);
      assert.equal(receiver.sentMessages.some((entry) => entry.message.content?.includes("wrong-intercom-must-be-dropped")), false);
      const dropped = receiver.appendEntries.filter((entry) => entry.type === "intercom_misroute_dropped");
      const sample = dropped[dropped.length - 1]!.payload as Record<string, unknown>;
      assert.equal(sample.reason, "receiver_intercom_session_mismatch");
      assert.equal(sample.intendedIntercomSessionId, "wrong-intercom-session");
      assert.equal(sample.actualIntercomSessionId, runtimeClient.sessionId);
    } finally {
      IntercomClient.prototype.connect = originalConnect;
      await receiver.emit("session_shutdown", ctx);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  });
});

test("dropped misroute diagnostics are structured and bounded", { concurrency: false }, async () => {
  await withBroker(async (homeDir) => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    const createdClients: IntercomClient[] = [];
    const originalConnect = IntercomClient.prototype.connect;
    IntercomClient.prototype.connect = async function capturedConnect(this: IntercomClient, session) {
      createdClients.push(this);
      return originalConnect.call(this, session);
    };

    const receiver = await createIntercomHarness("runtime-host");
    const ctx = createContext("pi-session-a", { idle: true, cwd: "/repo/a", hasUI: true });

    const from: SessionInfo = {
      id: "sender-session",
      piSessionId: "pi-sender",
      namespace: "test-namespace",
      alias: "sender",
      cwd: "/repo/sender",
      model: "test-model",
      pid: process.pid,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      leaseTtlMs: 30_000,
      heartbeatIntervalMs: 10_000,
      status: "idle",
    };

    try {
      await receiver.emit("session_start", ctx);
      await waitUntil(() => createdClients.length > 0, "runtime intercom client not created");
      const runtimeClient = createdClients[0]!;

      for (let i = 0; i < 80; i++) {
        runtimeClient.emit("message", from, {
          id: `misroute-${i}`,
          timestamp: Date.now() + i,
          to: {
            intercomSessionId: "runtime-intercom",
            piSessionId: "pi-session-b",
          },
          content: {
            text: `drop-${i}`,
          },
        } satisfies Message);
      }

      await wait(100);

      const dropped = receiver.appendEntries.filter((entry) => entry.type === "intercom_misroute_dropped");
      assert.equal(dropped.length > 0, true);
      const sample = dropped[dropped.length - 1]!.payload as Record<string, unknown>;
      assert.equal(typeof sample.messageId, "string");
      assert.equal(sample.senderId, "sender-session");
      assert.equal(sample.senderName, "sender");
      assert.equal(sample.intendedPiSessionId, "pi-session-b");
      assert.equal(sample.actualPiSessionId, "pi-session-a");
      assert.equal(typeof sample.timestamp, "number");
      assert.equal(sample.reason, "receiver_pi_session_mismatch");

      const status = await receiver.tool("intercom").execute("status-diagnostics", { action: "status" }, new AbortController().signal, undefined, ctx);
      assert.match(text(status), /Dropped misroutes: 50/);
    } finally {
      IntercomClient.prototype.connect = originalConnect;
      await receiver.emit("session_shutdown", ctx);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }
  });
});
