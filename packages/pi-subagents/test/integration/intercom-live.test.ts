import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createEventBus, discoverAndLoadExtensions, ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { IntercomClient } from "../../src/intercom-public/broker/client.ts";

const packageDir = process.cwd().endsWith(path.join("packages", "pi-subagents"))
	? process.cwd()
	: path.join(process.cwd(), "packages/pi-subagents");
const repoDir = path.dirname(path.dirname(packageDir));
const sharedHome = mkdtempSync(path.join(tmpdir(), "pi-subagents-intercom-home-"));
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
process.env.HOME = sharedHome;
process.env.USERPROFILE = sharedHome;

process.on("exit", () => {
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	if (previousUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = previousUserProfile;
	rmSync(sharedHome, { recursive: true, force: true });
});

const CHILD_ENV_KEYS = [
	"PI_SUBAGENT_CHILD",
	"PI_SUBAGENT_ORCHESTRATOR_TARGET",
	"PI_SUBAGENT_ORCHESTRATOR_CWD",
	"PI_SUBAGENT_SUPERVISOR_INTERCOM_SESSION_ID",
	"PI_SUBAGENT_SUPERVISOR_PI_SESSION_ID",
	"PI_SUBAGENT_SUPERVISOR_ALIAS",
	"PI_SUBAGENT_SUPERVISOR_CWD",
	"PI_SUBAGENT_RUN_ID",
	"PI_SUBAGENT_CHILD_AGENT",
	"PI_SUBAGENT_CHILD_INDEX",
	"PI_SUBAGENT_INTERCOM_SESSION_NAME",
] as const;

interface CapturedToolResult {
	content: Array<{ type: string; text: string }>;
	isError?: boolean;
	details?: Record<string, unknown>;
}

interface CapturedTool {
	name: string;
	parameters?: unknown;
	execute: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: unknown, ctx: unknown) => Promise<CapturedToolResult>;
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(assertion: () => boolean, message: string, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (assertion()) return;
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

async function withBroker<T>(fn: () => Promise<T>): Promise<T> {
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
		return await fn();
	} finally {
		broker.kill("SIGTERM");
		await once(broker, "exit").catch(() => undefined);
	}
}

async function withChildEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
	const previous = new Map<string, string | undefined>();
	for (const key of CHILD_ENV_KEYS) previous.set(key, process.env[key]);
	try {
		for (const key of CHILD_ENV_KEYS) delete process.env[key];
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		return await fn();
	} finally {
		for (const key of CHILD_ENV_KEYS) {
			const value = previous.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

async function createHarness(sessionName: string, options: { idle?: boolean; sessionIdPrefix?: string; stableSessionId?: boolean } = {}) {
	// Use Pi's real extension loader/runner so tests exercise lifecycle, context,
	// and tool registration semantics while keeping model/session behavior mocked.
	const sentMessages: Array<{ message: { customType?: string; content?: string; details?: unknown }; options?: { triggerTurn?: boolean; deliverAs?: string } }> = [];
	const entries: Array<{ type: string; data: unknown }> = [];
	const activeTools: string[] = [];
	let sessionCounter = 0;

	const loaded = await discoverAndLoadExtensions(
		[path.join(packageDir, "src/extension/index.ts")],
		repoDir,
		undefined,
		createEventBus(),
	);
	assert.deepEqual(loaded.errors, []);

	const sessionManager = {
		getSessionFile: () => null,
		getSessionId: () => `${options.sessionIdPrefix ?? sessionName}-session-${sessionCounter}`,
	};
	const modelRegistry = {
		getAvailable: () => [],
		registerProvider: () => undefined,
		unregisterProvider: () => undefined,
	};
	const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, repoDir, sessionManager as never, modelRegistry as never);
	runner.bindCore({
		sendMessage(message: { customType?: string; content?: string; details?: unknown }, sendOptions?: { triggerTurn?: boolean; deliverAs?: string }) {
			sentMessages.push({ message, options: sendOptions });
		},
		sendUserMessage: () => undefined,
		appendEntry(type: string, data: unknown) {
			entries.push({ type, data });
		},
		setSessionName: () => undefined,
		getSessionName: () => sessionName,
		setLabel: () => undefined,
		getActiveTools: () => activeTools,
		getAllTools: () => runner.getAllRegisteredTools().map((tool) => tool.definition.name),
		setActiveTools(tools: string[]) {
			activeTools.splice(0, activeTools.length, ...tools);
		},
		refreshTools: () => undefined,
		getCommands: () => runner.getRegisteredCommands(),
		setModel: async () => undefined,
		getThinkingLevel: () => undefined,
		setThinkingLevel: () => undefined,
	} as never, {
		getModel: () => ({ id: "test-model" }),
		isIdle: () => options.idle ?? true,
		getSignal: () => new AbortController().signal,
		abort: () => undefined,
		hasPendingMessages: () => false,
		shutdown: () => undefined,
		getContextUsage: () => undefined,
		compact: () => undefined,
		getSystemPrompt: () => "",
	} as never);

	return {
		runner,
		sentMessages,
		entries,
		get ctx() {
			return runner.createContext();
		},
		async start() {
			await runner.emit({ type: "session_start" } as never);
			assert.ok(runner.getToolDefinition("intercom"), "runner should register intercom tool");
			await this.tool("intercom").execute("status", { action: "status" }, new AbortController().signal, undefined, this.ctx);
		},
		async shutdown() {
			await runner.emit({ type: "session_shutdown" } as never);
			if (!options.stableSessionId) {
				sessionCounter += 1;
			}
		},
		tool(name: string): CapturedTool {
			const tool = runner.getToolDefinition(name) as CapturedTool | undefined;
			assert.ok(tool, `missing tool ${name}`);
			return tool;
		},
	};
}

function text(result: CapturedToolResult): string {
	return result.content.map((part) => part.text).join("\n");
}

function parseStatusSessionId(result: CapturedToolResult): string {
	const match = text(result).match(/Session ID: (.+)/);
	assert.ok(match, `Unable to parse Session ID from status: ${text(result)}`);
	return match[1]!.trim();
}

async function connectRegisteredClient(alias: string): Promise<IntercomClient> {
	const client = new IntercomClient();
	await client.connect({
		alias,
		piSessionId: `pi-${alias}`,
		namespace: "test-namespace",
		cwd: `/tmp/${alias}`,
		model: "test-model",
		pid: process.pid,
		startedAt: Date.now(),
		lastActivity: Date.now(),
		leaseTtlMs: 30_000,
		heartbeatIntervalMs: 10_000,
		status: "idle",
	});
	return client;
}

test("intercom send delivers message and records pending inbound ask", { concurrency: false }, async () => {
	await withBroker(async () => {
		const sender = await createHarness("sender");
		const receiver = await createHarness("receiver");
		try {
			await sender.start();
			await receiver.start();
			const sent = await sender.tool("intercom").execute("send", {
				action: "send",
				to: "receiver",
				message: "hello receiver",
				attachments: [{ type: "snippet", name: "note.ts", content: "const ok = true;", language: "ts" }],
			}, new AbortController().signal, undefined, sender.ctx);
			assert.equal(sent.isError, false);
			await waitUntil(() => receiver.sentMessages.some((entry) => entry.message.content?.includes("hello receiver")), "receiver did not get sent message");
			const delivered = receiver.sentMessages.map((entry) => entry.message.content ?? "").join("\n");
			assert.match(delivered, /hello receiver/);
			assert.match(delivered, /note\.ts/);
			assert.match(delivered, /const ok = true/);

			const pending = await receiver.tool("intercom").execute("pending", { action: "pending" }, new AbortController().signal, undefined, receiver.ctx);
			assert.match(text(pending), /No unresolved inbound asks/);
		} finally {
			await sender.shutdown();
			await receiver.shutdown();
		}
	});
});

test("intercom ask waits for reply tool response", { concurrency: false }, async () => {
	await withBroker(async () => {
		const asker = await createHarness("asker");
		const answerer = await createHarness("answerer");
		try {
			await asker.start();
			await answerer.start();
			const askPromise = asker.tool("intercom").execute("ask", {
				action: "ask",
				to: "answerer",
				message: "Need decision",
			}, new AbortController().signal, undefined, asker.ctx);
			await waitUntil(() => answerer.sentMessages.some((entry) => entry.message.content?.includes("Need decision")), "answerer did not receive ask");
			const pending = await answerer.tool("intercom").execute("pending", { action: "pending" }, new AbortController().signal, undefined, answerer.ctx);
			assert.match(text(pending), /Need decision/);
			const reply = await answerer.tool("intercom").execute("reply", {
				action: "reply",
				message: "Use option B",
			}, new AbortController().signal, undefined, answerer.ctx);
			assert.equal(reply.isError, false);
			const askResult = await askPromise;
			assert.equal(askResult.isError, false);
			assert.match(text(askResult), /Use option B/);
		} finally {
			await asker.shutdown();
			await answerer.shutdown();
		}
	});
});

test("intercom ask waits for late target registration before failing", { concurrency: false }, async () => {
	await withBroker(async () => {
		const asker = await createHarness("late-asker");
		let answerer: Awaited<ReturnType<typeof createHarness>> | null = null;
		try {
			await asker.start();
			const askPromise = asker.tool("intercom").execute("ask-late", {
				action: "ask",
				to: "late-answerer",
				message: "late-registration-question",
			}, new AbortController().signal, undefined, asker.ctx);

			await wait(350);
			answerer = await createHarness("late-answerer");
			await answerer.start();
			await waitUntil(() => answerer!.sentMessages.some((entry) => entry.message.content?.includes("late-registration-question")), "late answerer did not receive ask");

			const reply = await answerer.tool("intercom").execute("reply-late", {
				action: "reply",
				message: "late-registration-answer",
			}, new AbortController().signal, undefined, answerer.ctx);
			assert.equal(reply.isError, false);

			const askResult = await askPromise;
			assert.equal(askResult.isError, false, text(askResult));
			assert.match(text(askResult), /late-registration-answer/);
		} finally {
			if (answerer) await answerer.shutdown();
			await asker.shutdown();
		}
	});
});

test("intercom ask honors waitForReadyMs override when set to zero", { concurrency: false }, async () => {
	await withBroker(async () => {
		const asker = await createHarness("zero-wait-asker");
		let answerer: Awaited<ReturnType<typeof createHarness>> | null = null;
		try {
			await asker.start();
			const askResult = await asker.tool("intercom").execute("ask-zero-wait", {
				action: "ask",
				to: "zero-wait-answerer",
				message: "zero-wait-question",
				waitForReadyMs: 0,
			}, new AbortController().signal, undefined, asker.ctx);
			assert.equal(askResult.isError, true);
			assert.match(text(askResult), /not delivered|Session not found|may not exist|has disconnected/i);

			answerer = await createHarness("zero-wait-answerer");
			await answerer.start();
			await wait(150);
			assert.equal(answerer.sentMessages.some((entry) => entry.message.content?.includes("zero-wait-question")), false);
		} finally {
			if (answerer) await answerer.shutdown();
			await asker.shutdown();
		}
	});
});

test("intercom reply re-resolves sender via piSessionId after sender reconnect", { concurrency: false }, async () => {
	await withBroker(async () => {
		const askerA = await createHarness("sticky-asker", { sessionIdPrefix: "sticky", stableSessionId: true });
		const answerer = await createHarness("sticky-answerer");
		let askerB: Awaited<ReturnType<typeof createHarness>> | null = null;
		let askPromise: Promise<CapturedToolResult> | null = null;
		try {
			await askerA.start();
			await answerer.start();
			askPromise = askerA.tool("intercom").execute("ask-sticky", {
				action: "ask",
				to: "sticky-answerer",
				message: "sticky-question",
			}, new AbortController().signal, undefined, askerA.ctx);
			await waitUntil(() => answerer.sentMessages.some((entry) => entry.message.content?.includes("sticky-question")), "answerer did not receive sticky ask");

			await askerA.shutdown();

			askerB = await createHarness("sticky-asker", { sessionIdPrefix: "sticky", stableSessionId: true });
			await askerB.start();

			const reply = await answerer.tool("intercom").execute("reply-sticky", {
				action: "reply",
				message: "sticky-reply",
				waitForReadyMs: 2000,
			}, new AbortController().signal, undefined, answerer.ctx);
			assert.equal(reply.isError, false, text(reply));
			await waitUntil(() => askerB!.sentMessages.some((entry) => entry.message.content?.includes("sticky-reply")), "reconnected asker did not receive reply");
		} finally {
			if (askPromise) await askPromise.catch(() => undefined);
			if (askerB) await askerB.shutdown();
			await answerer.shutdown();
			await askerA.shutdown();
		}
	});
});

test("manual ask/reply/pending remains stable", { concurrency: false }, async () => {
	await withBroker(async () => {
		const asker = await createHarness("manual-asker");
		const answerer = await createHarness("manual-answerer");
		try {
			await asker.start();
			await answerer.start();

			const askPromise = asker.tool("intercom").execute("ask", {
				action: "ask",
				to: "manual-answerer",
				message: "manual-decision-needed",
			}, new AbortController().signal, undefined, asker.ctx);

			await waitUntil(() => answerer.sentMessages.some((entry) => entry.message.content?.includes("manual-decision-needed")), "answerer did not receive manual ask");

			const pendingBeforeReply = await answerer.tool("intercom").execute("pending-before", { action: "pending" }, new AbortController().signal, undefined, answerer.ctx);
			assert.match(text(pendingBeforeReply), /manual-decision-needed/);

			const reply = await answerer.tool("intercom").execute("reply", {
				action: "reply",
				message: "manual-decision-confirmed",
			}, new AbortController().signal, undefined, answerer.ctx);
			assert.equal(reply.isError, false);

			const askResult = await askPromise;
			assert.equal(askResult.isError, false);
			assert.match(text(askResult), /manual-decision-confirmed/);

			const pendingAfterReply = await answerer.tool("intercom").execute("pending-after", { action: "pending" }, new AbortController().signal, undefined, answerer.ctx);
			assert.match(text(pendingAfterReply), /No unresolved inbound asks/);
		} finally {
			await asker.shutdown();
			await answerer.shutdown();
		}
	});
});

test("list/status expose identity details without cluttering text", { concurrency: false }, async () => {
	await withBroker(async () => {
		const alpha = await createHarness("list-alpha");
		const beta = await createHarness("list-beta");
		try {
			await alpha.start();
			await beta.start();

			const list = await alpha.tool("intercom").execute("list", { action: "list" }, new AbortController().signal, undefined, alpha.ctx);
			assert.equal(list.isError, false);
			const listDetails = list.details as { currentSession?: { piSessionId?: string }; otherSessions?: Array<{ piSessionId?: string }> } | undefined;
			assert.ok(typeof listDetails?.currentSession?.piSessionId === "string" && listDetails.currentSession.piSessionId.length > 0);
			assert.ok(typeof listDetails?.otherSessions?.[0]?.piSessionId === "string" && listDetails.otherSessions[0].piSessionId.length > 0);

			const status = await alpha.tool("intercom").execute("status", { action: "status" }, new AbortController().signal, undefined, alpha.ctx);
			assert.equal(status.isError, false);
			const statusDetails = status.details as { session?: { piSessionId?: string } } | undefined;
			assert.ok(typeof statusDetails?.session?.piSessionId === "string" && statusDetails.session.piSessionId.length > 0);
		} finally {
			await alpha.shutdown();
			await beta.shutdown();
		}
	});
});

test("intercom ask reply includes attachment formatting", { concurrency: false }, async () => {
	await withBroker(async () => {
		const asker = await createHarness("attachment-asker");
		const answerer = await createHarness("attachment-answerer");
		try {
			await asker.start();
			await answerer.start();
			const askPromise = asker.tool("intercom").execute("ask", {
				action: "ask",
				to: "attachment-answerer",
				message: "Need file",
			}, new AbortController().signal, undefined, asker.ctx);
			await waitUntil(() => answerer.sentMessages.some((entry) => entry.message.content?.includes("Need file")), "answerer did not receive attachment ask");
			const incomingDetails = answerer.sentMessages.at(-1)?.message.details as { message?: { id?: string } } | undefined;
			const replyTo = incomingDetails?.message?.id;
			assert.ok(replyTo);
			const replyResult = await answerer.tool("intercom").execute("send", {
				action: "send",
				to: "attachment-asker",
				message: "See attached",
				replyTo,
				attachments: [{ type: "file", name: "answer.md", content: "# Answer", language: "md" }],
			}, new AbortController().signal, undefined, answerer.ctx);
			assert.equal(replyResult.isError, false);
			const askResult = await askPromise;
			assert.match(text(askResult), /See attached/);
			assert.match(text(askResult), /answer\.md/);
			assert.match(text(askResult), /# Answer/);
		} finally {
			await asker.shutdown();
			await answerer.shutdown();
		}
	});
});

test("contact_supervisor progress_update sends non-blocking update to parent", { concurrency: false }, async () => {
	await withBroker(async () => {
		const parent = await createHarness("parent-supervisor");
		try {
			await parent.start();
			await withChildEnv({
				PI_SUBAGENT_CHILD: "1",
				PI_SUBAGENT_ORCHESTRATOR_TARGET: "parent-supervisor",
				PI_SUBAGENT_SUPERVISOR_INTERCOM_SESSION_ID: "parent-supervisor",
				PI_SUBAGENT_SUPERVISOR_PI_SESSION_ID: parent.ctx.sessionManager.getSessionId(),
				PI_SUBAGENT_SUPERVISOR_ALIAS: "parent-supervisor",
				PI_SUBAGENT_SUPERVISOR_CWD: "/repo/parent",
				PI_SUBAGENT_RUN_ID: "run-progress",
				PI_SUBAGENT_CHILD_AGENT: "worker",
				PI_SUBAGENT_CHILD_INDEX: "0",
			}, async () => {
				const child = await createHarness("child-progress");
				try {
					await child.start();
					assert.ok(child.runner.getToolDefinition("contact_supervisor"), "runner should register child supervisor tool");
					const result = await child.tool("contact_supervisor").execute("contact", {
						reason: "progress_update",
						message: "UPDATE: half done",
					}, new AbortController().signal, undefined, child.ctx);
					assert.equal(result.isError, false);
					await waitUntil(() => parent.sentMessages.some((entry) => entry.message.content?.includes("UPDATE: half done")), "parent did not receive progress update");
					assert.match(parent.sentMessages.map((entry) => entry.message.content ?? "").join("\n"), /Run: run-progress/);
				} finally {
					await child.shutdown();
				}
			});
		} finally {
			await parent.shutdown();
		}
	});
});

test("contact_supervisor sends structured target envelope and routes by intercomSessionId", { concurrency: false }, async () => {
	await withBroker(async () => {
		const parentA = await createHarness("duplicate-supervisor", { sessionIdPrefix: "parent-a" });
		const parentB = await createHarness("duplicate-supervisor", { sessionIdPrefix: "parent-b" });
		try {
			await parentA.start();
			await parentB.start();
			const parentAStatus = await parentA.tool("intercom").execute("status-a", { action: "status" }, new AbortController().signal, undefined, parentA.ctx);
			const parentAIntercomSessionId = parseStatusSessionId(parentAStatus);
			const parentAPiSessionId = "parent-a-session-0";

			await withChildEnv({
				PI_SUBAGENT_CHILD: "1",
				PI_SUBAGENT_ORCHESTRATOR_TARGET: "duplicate-supervisor",
				PI_SUBAGENT_SUPERVISOR_INTERCOM_SESSION_ID: parentAIntercomSessionId,
				PI_SUBAGENT_SUPERVISOR_PI_SESSION_ID: parentAPiSessionId,
				PI_SUBAGENT_SUPERVISOR_ALIAS: "duplicate-supervisor",
				PI_SUBAGENT_SUPERVISOR_CWD: "/repo/parent-a",
				PI_SUBAGENT_RUN_ID: "run-structured",
				PI_SUBAGENT_CHILD_AGENT: "worker",
				PI_SUBAGENT_CHILD_INDEX: "0",
			}, async () => {
				const child = await createHarness("child-structured", { sessionIdPrefix: "child-structured" });
				try {
					await child.start();
					const decisionPromise = child.tool("contact_supervisor").execute("contact", {
						reason: "need_decision",
						message: "Route by intercom session id",
					}, new AbortController().signal, undefined, child.ctx);
					await waitUntil(() => parentA.sentMessages.some((entry) => entry.message.content?.includes("Route by intercom session id")), "parent A did not receive structured ask");
					assert.equal(parentB.sentMessages.some((entry) => entry.message.content?.includes("Route by intercom session id")), false);
					const reply = await parentA.tool("intercom").execute("reply", {
						action: "reply",
						message: "Routed to parent A",
					}, new AbortController().signal, undefined, parentA.ctx);
					assert.equal(reply.isError, false);
					const decision = await decisionPromise;
					assert.equal(decision.isError, false);
					assert.match(text(decision), /Routed to parent A/);
				} finally {
					await child.shutdown();
				}
			});
		} finally {
			await parentA.shutdown();
			await parentB.shutdown();
		}
	});
});

test("contact_supervisor re-resolves by piSessionId when supervisor intercomSessionId is stale", { concurrency: false }, async () => {
	await withBroker(async () => {
		const parent = await createHarness("reconnect-parent", { sessionIdPrefix: "reconnect-parent", stableSessionId: true });
		try {
			await parent.start();
			const oldStatus = await parent.tool("intercom").execute("status-old", { action: "status" }, new AbortController().signal, undefined, parent.ctx);
			const staleIntercomSessionId = parseStatusSessionId(oldStatus);
			const stablePiSessionId = "reconnect-parent-session-0";

			await parent.shutdown();
			await parent.start();
			const newStatus = await parent.tool("intercom").execute("status-new", { action: "status" }, new AbortController().signal, undefined, parent.ctx);
			const currentIntercomSessionId = parseStatusSessionId(newStatus);
			assert.notEqual(currentIntercomSessionId, staleIntercomSessionId);

			await withChildEnv({
				PI_SUBAGENT_CHILD: "1",
				PI_SUBAGENT_ORCHESTRATOR_TARGET: "reconnect-parent",
				PI_SUBAGENT_SUPERVISOR_INTERCOM_SESSION_ID: staleIntercomSessionId,
				PI_SUBAGENT_SUPERVISOR_PI_SESSION_ID: stablePiSessionId,
				PI_SUBAGENT_SUPERVISOR_ALIAS: "reconnect-parent",
				PI_SUBAGENT_SUPERVISOR_CWD: "/repo/reconnect-parent",
				PI_SUBAGENT_RUN_ID: "run-reconnect",
				PI_SUBAGENT_CHILD_AGENT: "worker",
				PI_SUBAGENT_CHILD_INDEX: "0",
			}, async () => {
				const child = await createHarness("child-reconnect", { sessionIdPrefix: "child-reconnect" });
				try {
					await child.start();
					const result = await child.tool("contact_supervisor").execute("contact", {
						reason: "progress_update",
						message: "UPDATE: stale-id re-resolution",
					}, new AbortController().signal, undefined, child.ctx);
					assert.equal(result.isError, false, text(result));
					await waitUntil(() => parent.sentMessages.some((entry) => entry.message.content?.includes("UPDATE: stale-id re-resolution")), "parent did not receive stale-id re-resolution update");
				} finally {
					await child.shutdown();
				}
			});
		} finally {
			await parent.shutdown();
		}
	});
});

test("contact_supervisor env-only metadata fails closed without exact identity", { concurrency: false }, async () => {
	await withBroker(async () => {
		await withChildEnv({
			PI_SUBAGENT_CHILD: "1",
			PI_SUBAGENT_ORCHESTRATOR_TARGET: "env-parent",
			PI_SUBAGENT_ORCHESTRATOR_CWD: "/repo/env-parent",
			PI_SUBAGENT_RUN_ID: "run-env-only",
			PI_SUBAGENT_CHILD_AGENT: "worker",
			PI_SUBAGENT_CHILD_INDEX: "0",
		}, async () => {
			const child = await createHarness("env-child", { sessionIdPrefix: "env-child" });
			try {
				await child.start();
				assert.equal(child.runner.getToolDefinition("contact_supervisor"), undefined);
			} finally {
				await child.shutdown();
			}
		});
	});
});

test("contact_supervisor need_decision waits for parent reply", { concurrency: false }, async () => {
	await withBroker(async () => {
		const parent = await createHarness("decision-parent");
		try {
			await parent.start();
			await withChildEnv({
				PI_SUBAGENT_CHILD: "1",
				PI_SUBAGENT_ORCHESTRATOR_TARGET: "decision-parent",
				PI_SUBAGENT_SUPERVISOR_INTERCOM_SESSION_ID: "decision-parent",
				PI_SUBAGENT_SUPERVISOR_PI_SESSION_ID: parent.ctx.sessionManager.getSessionId(),
				PI_SUBAGENT_SUPERVISOR_ALIAS: "decision-parent",
				PI_SUBAGENT_SUPERVISOR_CWD: "/repo/decision",
				PI_SUBAGENT_RUN_ID: "run-decision",
				PI_SUBAGENT_CHILD_AGENT: "worker",
				PI_SUBAGENT_CHILD_INDEX: "1",
			}, async () => {
				const child = await createHarness("decision-child");
				try {
					await child.start();
					assert.ok(child.runner.getToolDefinition("contact_supervisor"), "runner should register child supervisor tool");
					const decisionPromise = child.tool("contact_supervisor").execute("contact", {
						reason: "need_decision",
						message: "Should I proceed?",
					}, new AbortController().signal, undefined, child.ctx);
					await waitUntil(() => parent.sentMessages.some((entry) => entry.message.content?.includes("Should I proceed?")), "parent did not receive decision ask");
					const reply = await parent.tool("intercom").execute("reply", {
						action: "reply",
						message: "Proceed carefully",
					}, new AbortController().signal, undefined, parent.ctx);
					assert.equal(reply.isError, false);
					const decision = await decisionPromise;
					assert.equal(decision.isError, false);
					assert.match(text(decision), /Proceed carefully/);
				} finally {
					await child.shutdown();
				}
			});
		} finally {
			await parent.shutdown();
		}
	});
});

test("contact_supervisor interview_request returns structured responses", { concurrency: false }, async () => {
	await withBroker(async () => {
		const parent = await createHarness("interview-parent");
		try {
			await parent.start();
			await withChildEnv({
				PI_SUBAGENT_CHILD: "1",
				PI_SUBAGENT_ORCHESTRATOR_TARGET: "interview-parent",
				PI_SUBAGENT_SUPERVISOR_INTERCOM_SESSION_ID: "interview-parent",
				PI_SUBAGENT_SUPERVISOR_PI_SESSION_ID: parent.ctx.sessionManager.getSessionId(),
				PI_SUBAGENT_SUPERVISOR_ALIAS: "interview-parent",
				PI_SUBAGENT_SUPERVISOR_CWD: "/repo/interview",
				PI_SUBAGENT_RUN_ID: "run-interview",
				PI_SUBAGENT_CHILD_AGENT: "planner",
				PI_SUBAGENT_CHILD_INDEX: "2",
			}, async () => {
				const child = await createHarness("interview-child");
				try {
					await child.start();
					assert.ok(child.runner.getToolDefinition("contact_supervisor"), "runner should register child supervisor tool");
					const interviewPromise = child.tool("contact_supervisor").execute("contact", {
						reason: "interview_request",
						message: "Need structured choices",
						interview: {
							title: "Scope",
							questions: [
								{ id: "scope", type: "single", question: "Which scope?", options: ["minimal", "full"] },
								{ id: "notes", type: "text", question: "Any notes?" },
							],
						},
					}, new AbortController().signal, undefined, child.ctx);
					await waitUntil(() => parent.sentMessages.some((entry) => entry.message.content?.includes("Need structured choices")), "parent did not receive interview request");
					const parentMessageText = parent.sentMessages.map((entry) => entry.message.content ?? "").join("\n");
					assert.match(parentMessageText, /Which scope\?/);
					assert.match(parentMessageText, /minimal/);
					const reply = await parent.tool("intercom").execute("reply", {
						action: "reply",
						message: JSON.stringify({ responses: [{ id: "scope", value: "minimal" }, { id: "notes", value: "ship lean" }] }),
					}, new AbortController().signal, undefined, parent.ctx);
					assert.equal(reply.isError, false);
					const interview = await interviewPromise;
					assert.equal(interview.isError, false);
					assert.match(text(interview), /responses/);
					assert.deepEqual(interview.details?.structuredReply, {
						responses: [{ id: "scope", value: "minimal" }, { id: "notes", value: "ship lean" }],
					});
				} finally {
					await child.shutdown();
				}
			});
		} finally {
			await parent.shutdown();
		}
	});
});
