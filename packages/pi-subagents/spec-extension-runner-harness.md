# Spec: Replace Homegrown Extension Test Harness with Upstream `ExtensionRunner`

## Overview

`packages/pi-subagents/test/integration/intercom-live.test.ts` currently uses a custom `createHarness()` fake Pi API to register tools, emit lifecycle events, and capture messages. This gives useful coverage, but it does not exercise upstream Pi extension loading and runner semantics.

Replace this homegrown harness with a test harness built on `@mariozechner/pi-coding-agent`'s exported extension runtime primitives:

- `discoverAndLoadExtensions`
- `createEventBus`
- `ExtensionRunner`

Goal: keep tests mocked and deterministic, but make them feel more like real Pi sessions by letting upstream Pi code perform extension loading, tool registration, lifecycle event dispatch, context creation, and registered-tool lookup.

## Goals

1. Use upstream Pi extension runner primitives in `intercom-live.test.ts`.
2. Preserve current test behavior and assertions for intercom and `contact_supervisor` flows.
3. Add assertions that prove tests are using upstream runner semantics, not fake-only behavior.
4. Keep tests fast, deterministic, and free of real model or real `pi` CLI dependency.
5. Avoid broad production code changes unless needed to support testability.

## Non-goals

1. Do not run real `pi` binary.
2. Do not call real LLM/model providers.
3. Do not replace mock child CLI in `subagent-execution.test.ts`.
4. Do not rewrite every test harness in package.
5. Do not change public extension behavior.

## Current State

`intercom-live.test.ts` starts real intercom broker process, then creates session harnesses with hand-written fake `pi` object:

- `pi.registerTool(tool)` stores tools in array.
- `pi.on(event, handler)` stores lifecycle handlers in map.
- `pi.sendMessage(...)` records messages.
- `pi.appendEntry(...)` records entries.
- `pi.getSessionName()` returns configured session name.
- `start()` directly calls extension factory and manually invokes `session_start` handlers.
- `shutdown()` manually invokes `session_shutdown` handlers.

This bypasses upstream extension loader/runner behavior.

## Proposed Design

Create a reusable test helper in `intercom-live.test.ts` or `test/support/pi-runner-harness.ts` named `createRunnerHarness()`.

This helper must:

1. Load actual extension through upstream loader:

```ts
const loaded = await discoverAndLoadExtensions(
  [path.join(packageDir, "src/extension/index.ts")],
  cwd,
  undefined,
  createEventBus(),
);
```

2. Assert no extension load errors:

```ts
assert.deepEqual(loaded.errors, []);
```

3. Construct `ExtensionRunner` with minimal mocked `sessionManager` and `modelRegistry`:

```ts
const runner = new ExtensionRunner(
  loaded.extensions,
  loaded.runtime,
  cwd,
  sessionManager as never,
  modelRegistry as never,
);
```

4. Bind core runtime actions via `runner.bindCore(...)`:

- `sendMessage`: capture sent messages.
- `sendUserMessage`: no-op or capture if needed.
- `appendEntry`: capture custom entries.
- `setSessionName`: capture latest value if extension calls it.
- `getSessionName`: return configured session name.
- `setLabel`: no-op.
- `getActiveTools`: return mutable active tools array.
- `getAllTools`: return runner registered tool names.
- `setActiveTools`: update active tools array.
- `refreshTools`: no-op or counter increment.
- `getCommands`: return `runner.getRegisteredCommands()`.
- `setModel`: async no-op.
- `getThinkingLevel`: return undefined.
- `setThinkingLevel`: no-op.

5. Bind context actions via second `bindCore` argument:

- `getModel`: return `{ id: "test-model" }`.
- `isIdle`: return configured idle state, default `true`.
- `getSignal`: return abort signal.
- `abort`: no-op.
- `hasPendingMessages`: return false.
- `shutdown`: no-op.
- `getContextUsage`: return undefined.
- `compact`: no-op.
- `getSystemPrompt`: return empty string.

6. Expose helper API:

```ts
interface RunnerHarness {
  runner: ExtensionRunner;
  sentMessages: Array<{ message: unknown; options?: unknown }>;
  entries: Array<{ type: string; data: unknown }>;
  start(): Promise<void>;
  shutdown(): Promise<void>;
  tool(name: string): ToolDefinition;
  ctx(): ExtensionContext;
}
```

7. Implement `start()` and `shutdown()` using upstream runner event dispatch:

```ts
await runner.emit({ type: "session_start" });
await runner.emit({ type: "session_shutdown" });
```

8. Implement tool lookup using upstream registered tool surface:

```ts
const definition = runner.getToolDefinition(name);
assert.ok(definition, `missing tool ${name}`);
return definition;
```

9. Execute tools with `runner.createContext()`:

```ts
await harness.tool("intercom").execute(
  "tool-call-id",
  params,
  new AbortController().signal,
  undefined,
  harness.ctx(),
);
```

## Functional Requirements

1. Existing intercom live integration tests must continue to pass:
   - send delivers message and records pending inbound ask
   - ask waits for reply tool response
   - ask reply includes attachment formatting
   - `contact_supervisor progress_update` sends non-blocking update
   - `contact_supervisor need_decision` waits for parent reply
   - `contact_supervisor interview_request` returns structured responses

2. Harness must load `src/extension/index.ts` using `discoverAndLoadExtensions`, not direct import + direct factory call.

3. Harness must use `ExtensionRunner` for:
   - lifecycle event emission
   - context creation
   - registered tool lookup

4. Tests must assert runner-loaded extension state at least once:
   - `runner.getAllRegisteredTools()` includes `intercom` in normal session.
   - child env session includes `contact_supervisor`.

5. Tests must keep shared `HOME`/`USERPROFILE` temp isolation for broker state.

6. Tests must keep real broker process for intercom behavior.

7. Tests must avoid real model/provider calls.

## Implementation Plan

### Step 1: Add imports

In `test/integration/intercom-live.test.ts`, import from upstream package:

```ts
import {
  createEventBus,
  discoverAndLoadExtensions,
  ExtensionRunner,
  type ExtensionContext,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
```

If type imports differ, inspect `node_modules/@mariozechner/pi-coding-agent/dist/index.d.ts` and adjust.

### Step 2: Replace `createHarness()` internals

Keep same external shape where practical:

- `start()`
- `shutdown()`
- `tool(name)`
- `sentMessages`
- `entries`
- `ctx`

This minimizes edits to existing tests.

Old tests call:

```ts
await sender.start();
const result = await sender.tool("intercom").execute(..., sender.ctx);
```

New helper may expose `ctx()` method. To minimize churn, either:

A. keep `ctx` as getter property returning `runner.createContext()`, or
B. update call sites to `sender.ctx()`.

Prefer A for less churn:

```ts
get ctx() {
  return runner.createContext();
}
```

### Step 3: Preserve idle option

Old harness supports:

```ts
createHarness("parent", { idle: false })
```

New context action `isIdle` must return `options.idle ?? true`.

### Step 4: Preserve session counter if needed

Old `shutdown()` increments `sessionCounter`. If tests depend on changing session id after shutdown, keep counter. Otherwise okay to preserve harmlessly:

```ts
let sessionCounter = 0;
getSessionId: () => `${sessionName}-session-${sessionCounter}`;
shutdown: async () => {
  await runner.emit({ type: "session_shutdown" });
  sessionCounter += 1;
}
```

### Step 5: Add runner-surface assertions

Add or update registration tests inside `intercom-live.test.ts`:

Normal session:

```ts
const normal = createHarness("normal");
await normal.start();
assert.ok(normal.runner.getToolDefinition("intercom"));
assert.equal(normal.runner.getToolDefinition("contact_supervisor"), undefined);
```

Child env session:

```ts
await withChildEnv({
  PI_SUBAGENT_CHILD: "1",
  PI_SUBAGENT_ORCHESTRATOR_TARGET: "parent",
  PI_SUBAGENT_RUN_ID: "run-1",
  PI_SUBAGENT_CHILD_AGENT: "worker",
  PI_SUBAGENT_CHILD_INDEX: "0",
  PI_SUBAGENT_INTERCOM_SESSION_NAME: "subagent-worker-run-1-1",
}, async () => {
  const child = createHarness("subagent-worker-run-1-1");
  await child.start();
  assert.ok(child.runner.getToolDefinition("contact_supervisor"));
});
```

If existing unit test already covers this, still useful here because it proves runner harness observes same behavior.

### Step 6: Run tests

Run:

```sh
cd packages/pi-subagents
npm test
```

If `src/**/*.test.ts` script gets updated separately, also run:

```sh
node --experimental-transform-types --test 'test/**/*.test.ts' 'src/**/*.test.ts'
```

## Technical Considerations

### ExtensionRunner constructor requires `SessionManager` and `ModelRegistry`

Tests can pass minimal objects cast as `never`/specific types because extension code only needs small subset through context/runtime actions. Prefer minimal mocks over real session manager to keep setup simple.

### `discoverAndLoadExtensions` may resolve package imports differently than direct import

This is desired. It catches extension loader compatibility problems earlier.

### Context shape from `runner.createContext()` may include more fields than current mock

This is desired. Tests should stop hand-maintaining exact context shape unless extension code needs extra test-controlled values.

### Broker tests mutate process env

Keep `withChildEnv` and shared temp `HOME`/`USERPROFILE` isolation. Ensure env cleanup still runs on failure.

### Avoid import cycles

Import upstream from public package root `@mariozechner/pi-coding-agent`, not deep `dist/core/...`, unless public root lacks necessary types. Runtime APIs are public exports.

## Success Criteria

1. `intercom-live.test.ts` no longer directly imports `../../src/extension/index.ts` for harness startup.
2. `createHarness()` uses `discoverAndLoadExtensions` and `ExtensionRunner`.
3. Existing six intercom live tests pass unchanged or with only minor call-site updates.
4. New/updated assertions verify tool registration through `runner.getToolDefinition()`.
5. `npm test` passes.
6. No production source changes required.

## Example Helper Skeleton

```ts
async function createHarness(sessionName: string, options: { idle?: boolean } = {}) {
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
    getSessionId: () => `${sessionName}-session-${sessionCounter}`,
  };

  const modelRegistry = {
    getAvailable: () => [],
    registerProvider: () => undefined,
    unregisterProvider: () => undefined,
  };

  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    repoDir,
    sessionManager as never,
    modelRegistry as never,
  );

  runner.bindCore(
    {
      sendMessage(message, sendOptions) {
        sentMessages.push({ message, options: sendOptions });
      },
      sendUserMessage: () => undefined,
      appendEntry(type, data) {
        entries.push({ type, data });
      },
      setSessionName: () => undefined,
      getSessionName: () => sessionName,
      setLabel: () => undefined,
      getActiveTools: () => activeTools,
      getAllTools: () => runner.getAllRegisteredTools().map((tool) => tool.definition.name),
      setActiveTools(tools) {
        activeTools.splice(0, activeTools.length, ...tools);
      },
      refreshTools: () => undefined,
      getCommands: () => runner.getRegisteredCommands(),
      setModel: async () => undefined,
      getThinkingLevel: () => undefined,
      setThinkingLevel: () => undefined,
    } as never,
    {
      getModel: () => ({ id: "test-model" }),
      isIdle: () => options.idle ?? true,
      getSignal: () => new AbortController().signal,
      abort: () => undefined,
      hasPendingMessages: () => false,
      shutdown: () => undefined,
      getContextUsage: () => undefined,
      compact: () => undefined,
      getSystemPrompt: () => "",
    } as never,
  );

  return {
    runner,
    sentMessages,
    entries,
    get ctx() {
      return runner.createContext();
    },
    async start() {
      await runner.emit({ type: "session_start" });
      await this.tool("intercom").execute(
        "status",
        { action: "status" },
        new AbortController().signal,
        undefined,
        this.ctx,
      );
    },
    async shutdown() {
      await runner.emit({ type: "session_shutdown" });
      sessionCounter += 1;
    },
    tool(name: string) {
      const definition = runner.getToolDefinition(name);
      assert.ok(definition, `missing tool ${name}`);
      return definition;
    },
  };
}
```
