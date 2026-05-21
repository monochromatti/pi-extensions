import assert from "node:assert/strict";
import test from "node:test";
import registerSubagentExtension from "../../src/extension/index.ts";

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

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
	const previous = new Map<string, string | undefined>();
	for (const key of CHILD_ENV_KEYS) previous.set(key, process.env[key]);
	try {
		for (const key of CHILD_ENV_KEYS) delete process.env[key];
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fn();
	} finally {
		for (const key of CHILD_ENV_KEYS) {
			const value = previous.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		const cleanup = (globalThis as { __piSubagentRuntimeCleanup?: unknown }).__piSubagentRuntimeCleanup;
		if (typeof cleanup === "function") cleanup();
	}
}

function createFakePi() {
	const tools: Array<{ name: string; parameters?: unknown }> = [];
	const commands: string[] = [];
	const shortcuts: string[] = [];
	const messageRenderers: string[] = [];
	const handlers: string[] = [];
	const eventHandlers: string[] = [];
	const pi = {
		registerTool(tool: { name: string; parameters?: unknown }) {
			tools.push(tool);
		},
		registerCommand(name: string) {
			commands.push(name);
		},
		registerShortcut(name: string) {
			shortcuts.push(name);
		},
		registerMessageRenderer(name: string) {
			messageRenderers.push(name);
		},
		on(name: string) {
			handlers.push(name);
		},
		events: {
			on(name: string) {
				eventHandlers.push(name);
				return () => {};
			},
			emit() {},
		},
		getSessionName() {
			return "fake-session";
		},
		sendMessage() {},
		appendEntry() {},
	};
	return { pi: pi as any, tools, commands, shortcuts, messageRenderers, handlers, eventHandlers };
}

function toolNames(tools: Array<{ name: string }>): string[] {
	return tools.map((tool) => tool.name).sort();
}

test("10.7 normal session registers exactly public tools and no commands or shortcuts", () => {
	withEnv({}, () => {
		const fake = createFakePi();
		registerSubagentExtension(fake.pi);

		assert.deepEqual(toolNames(fake.tools), ["intercom", "subagent"]);
		assert.deepEqual(fake.commands, []);
		assert.deepEqual(fake.shortcuts, []);
		assert.equal(fake.tools.some((tool) => tool.name === "contact_supervisor"), false);
	});
});

test("8.3 child subagent session registers contact_supervisor", () => {
	withEnv({
		PI_SUBAGENT_CHILD: "1",
		PI_SUBAGENT_ORCHESTRATOR_TARGET: "parent-session",
		PI_SUBAGENT_SUPERVISOR_INTERCOM_SESSION_ID: "parent-intercom",
		PI_SUBAGENT_SUPERVISOR_PI_SESSION_ID: "parent-pi",
		PI_SUBAGENT_SUPERVISOR_ALIAS: "parent-session",
		PI_SUBAGENT_SUPERVISOR_CWD: "/repo/parent",
		PI_SUBAGENT_RUN_ID: "run-123",
		PI_SUBAGENT_CHILD_AGENT: "worker",
		PI_SUBAGENT_CHILD_INDEX: "0",
	}, () => {
		const fake = createFakePi();
		registerSubagentExtension(fake.pi);

		assert.deepEqual(toolNames(fake.tools), ["contact_supervisor", "intercom"]);
		assert.deepEqual(fake.commands, []);
		assert.deepEqual(fake.shortcuts, []);
	});
});

test("8.4 child subagent session with partial PI_SUBAGENT_SUPERVISOR_* metadata fails safe and does not register contact_supervisor", () => {
	withEnv({
		PI_SUBAGENT_CHILD: "1",
		PI_SUBAGENT_ORCHESTRATOR_TARGET: "parent-session",
		PI_SUBAGENT_ORCHESTRATOR_CWD: "/repo/parent",
		PI_SUBAGENT_SUPERVISOR_ALIAS: "parent-session",
		PI_SUBAGENT_RUN_ID: "run-123",
		PI_SUBAGENT_CHILD_AGENT: "worker",
		PI_SUBAGENT_CHILD_INDEX: "0",
	}, () => {
		const fake = createFakePi();
		registerSubagentExtension(fake.pi);

		assert.deepEqual(toolNames(fake.tools), ["intercom"]);
		assert.equal(fake.tools.some((tool) => tool.name === "contact_supervisor"), false);
	});
});

test("8.4 legacy-only child env still registers contact_supervisor", () => {
	withEnv({
		PI_SUBAGENT_CHILD: "1",
		PI_SUBAGENT_ORCHESTRATOR_TARGET: "parent-session",
		PI_SUBAGENT_ORCHESTRATOR_CWD: "/repo/parent",
		PI_SUBAGENT_RUN_ID: "run-legacy",
		PI_SUBAGENT_CHILD_AGENT: "worker",
		PI_SUBAGENT_CHILD_INDEX: "1",
	}, () => {
		const fake = createFakePi();
		registerSubagentExtension(fake.pi);

		assert.deepEqual(toolNames(fake.tools), ["contact_supervisor", "intercom"]);
	});
});

test("7.3 intercom public action schema exposes supported actions", () => {
	withEnv({}, () => {
		const fake = createFakePi();
		registerSubagentExtension(fake.pi);
		const intercom = fake.tools.find((tool) => tool.name === "intercom") as { parameters?: { properties?: { action?: { enum?: string[] } } } } | undefined;
		assert.ok(intercom);
		assert.deepEqual(intercom.parameters?.properties?.action?.enum, ["list", "send", "ask", "reply", "pending", "status"]);
	});
});

test("8.3 contact_supervisor reason schema exposes child-only reasons", () => {
	withEnv({
		PI_SUBAGENT_CHILD: "1",
		PI_SUBAGENT_ORCHESTRATOR_TARGET: "parent-session",
		PI_SUBAGENT_SUPERVISOR_INTERCOM_SESSION_ID: "parent-intercom",
		PI_SUBAGENT_SUPERVISOR_PI_SESSION_ID: "parent-pi",
		PI_SUBAGENT_SUPERVISOR_ALIAS: "parent-session",
		PI_SUBAGENT_SUPERVISOR_CWD: "/repo/parent",
		PI_SUBAGENT_RUN_ID: "run-123",
		PI_SUBAGENT_CHILD_AGENT: "worker",
		PI_SUBAGENT_CHILD_INDEX: "0",
	}, () => {
		const fake = createFakePi();
		registerSubagentExtension(fake.pi);
		const contact = fake.tools.find((tool) => tool.name === "contact_supervisor") as { parameters?: { properties?: { reason?: { enum?: string[] } } } } | undefined;
		assert.ok(contact);
		assert.deepEqual(contact.parameters?.properties?.reason?.enum, ["need_decision", "progress_update", "interview_request"]);
	});
});

test("7.1 registration still loads after shared module split", async () => {
	const [types, depth, tempPaths, output, statusStore, messages, errorDetection, toolPreview] = await Promise.all([
		import("../../src/shared/types.ts"),
		import("../../src/shared/depth.ts"),
		import("../../src/shared/temp-paths.ts"),
		import("../../src/shared/output.ts"),
		import("../../src/runs/background/status-store.ts"),
		import("../../src/shared/messages.ts"),
		import("../../src/shared/error-detection.ts"),
		import("../../src/shared/tool-preview.ts"),
	]);

	assert.equal(typeof types.checkSubagentDepth, "function");
	assert.equal(typeof depth.checkSubagentDepth, "function");
	assert.equal(typeof tempPaths.resolveTempScopeId, "function");
	assert.equal(typeof output.truncateOutput, "function");
	assert.equal(typeof statusStore.readStatus, "function");
	assert.equal(typeof messages.getFinalOutput, "function");
	assert.equal(typeof errorDetection.detectSubagentError, "function");
	assert.equal(typeof toolPreview.extractToolArgsPreview, "function");

	withEnv({}, () => {
		const fake = createFakePi();
		registerSubagentExtension(fake.pi);
		assert.deepEqual(toolNames(fake.tools), ["intercom", "subagent"]);
	});
});
