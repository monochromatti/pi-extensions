# Spec: Session-Scoped pi-intercom Routing

## Introduction

`pi-intercom` currently risks delivering supervisor/subagent coordination messages into unrelated Pi sessions. Root cause is architecture shape: intercom runtime state is process-global while Pi may host multiple active sessions in one process, and subagent orchestration routes by mutable human-facing names/fallback aliases instead of an exact live receiver identity.

This spec defines target architecture for fixing leakage inside this repository only. Goal: make intercom a session-scoped module with exact addressed delivery for subagent coordination. The design follows good-code principles: deep modules, small caller interfaces, strong locality, and behavior-focused tests.

## Problem

Observed leakage example:

```text
From: subagent-chat-019e4a38 (.../prodrisk/main)
Need help: exact local paths ...
```

This appears in random sessions unrelated to delegating session.

Likely contributing issues:

1. `packages/pi-subagents/src/intercom-public/index.ts` owns runtime state as module-level singletons (`runtimeContext`, `currentSessionId`, `client`, `replyTracker`, pending queues, waiters, timers).
2. Multiple Pi sessions in one process can overwrite this state through lifecycle events.
3. Subagent supervisor routing currently resolves to a string target derived from session name/fallback alias.
4. Broker name lookup is global to user home; names are not suitable for orchestration identity.
5. Subagent control/result relay events are not owned by an explicit parent Pi session ID.

## Goals

1. Ensure messages intended for one Pi session cannot be displayed in any other Pi session.
2. Make each Pi session own independent intercom runtime state.
3. Route subagent supervisor traffic primarily by broker-assigned `intercomSessionId`.
4. Use `piSessionId` as fallback identity when broker connection ID changes.
5. Keep human-facing session names for UI/manual intercom only.
6. Keep change local to packages in this repository.
7. Preserve simple caller interfaces: subagent code should call `contact_supervisor`; it should not know routing mechanics.

## Non-goals

1. Do not redesign all user-facing `intercom send/list/ask/reply` behavior.
2. Do not require changes outside this repository.
3. Do not make namespace mandatory for exact ID routing.
4. Do not support degraded subagent bridge launches when parent intercom cannot register.
5. Do not preserve old in-process singleton assumptions.

## Target Architecture

### Core invariants

Every intercom runtime belongs to exactly one Pi session.

Identity assumptions are load-bearing:

1. `piSessionId` is unique among active sessions in one Pi process.
2. `piSessionId` is immutable for session lifetime.
3. `piSessionId` is not reused while an old runtime for that ID may still have active async work.
4. Broker `intercomSessionId` is unique among connected broker sessions.
5. Human-facing names are labels only; orchestration must not rely on them as primary identity.

Every subagent supervisor message has exact intended receiver identity:

```ts
interface SupervisorIntercomTarget {
  piSessionId: string;
  intercomSessionId: string;
  alias: string;
  cwd: string;
}
```

Primary route: `intercomSessionId`.
Fallback route: `piSessionId`.
Alias route is only last-resort/manual compatibility, not normal orchestration path. Routing fallback order belongs in broker target resolution, not duplicated across child tools/callers.

### Session-scoped runtime module

Replace process-global mutable runtime state in `intercom-public/index.ts` with an `IntercomRuntime` module.

Conceptual shape:

```ts
class IntercomRuntime {
  readonly piSessionId: string;
  readonly ctx: ExtensionContext;
  readonly startedAt: number;
  readonly alias: string;

  client: IntercomClient | null;
  replyTracker: ReplyTracker;
  pendingIdleMessages: InboundMessageEntry[];
  replyWaiter: ReplyWaiter | null;

  async start(): Promise<void>;
  async shutdown(): Promise<void>;
  async ensureConnected(reason: ConnectReason): Promise<IntercomClient>;

  handleIncomingMessage(from: SessionInfo, message: Message): void;
  executeIntercomTool(params: IntercomParams): Promise<ToolResult>;
  executeContactSupervisorTool(params: ContactSupervisorParams): Promise<ToolResult>;

  ownsContext(ctx: ExtensionContext): boolean;
}
```

Module-level extension state becomes only registry/coordinator state:

```ts
const runtimes = new Map<string, IntercomRuntime>();
```

Rules:

1. `session_start` creates/replaces runtime for `ctx.sessionManager.getSessionId()`.
2. `session_shutdown` shuts down/removes only matching runtime.
3. Tool handlers resolve runtime from provided execution `ctx`.
4. Inbound broker event handlers close over their owning `IntercomRuntime` instance.
5. No inbound message delivery path may reference module-level `runtimeContext` or `currentSessionId`.

This is the main good-code seam: callers ask runtime to perform intercom behavior; runtime owns connection, validation, queues, reply matching, UI delivery, and lifecycle policy.

`IntercomRuntime` should be a facade, not a giant object with all implementation mixed together. Internals should be split behind private/local seams where that improves locality:

- `RuntimeTransport`: broker connect/register/reconnect/presence.
- `RuntimeInbox`: inbound queue, reply waiters, turn-context integration, UI handoff.
- `RuntimeRouter`: target envelopes, receiver sanity checks, relay dispatch.

Callers still depend on one runtime facade. Internal seams exist to keep behavior changes local, not to force callers to coordinate steps.

Lifecycle race rules:

1. Each runtime has a generation/cancel token.
2. Async work checks that `runtimes.get(piSessionId) === runtime` before delivering UI messages or emitting follow-up effects.
3. Shutdown unregisters broker/listener callbacks before awaiting network disconnect.
4. Replacing a runtime for the same `piSessionId` cancels old runtime before new runtime can display messages.

### Broker protocol additions

Extend `SessionInfo` with Pi session identity and optional namespace:

```ts
interface SessionInfo {
  id: string;          // broker-assigned intercom session id
  piSessionId: string; // Pi session id from ctx.sessionManager.getSessionId()
  protocolVersion: number;
  capabilities: string[];
  namespace?: string;  // used only to constrain name lookup
  name?: string;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
}
```

Broker registration must require `piSessionId` from protocol v2 clients. Clients should register with:

```ts
protocolVersion: 2,
capabilities: ["piSessionId-routing"]
```

Manual intercom can soft-degrade for older clients where practical. Subagent bridge must hard-fail if parent or target cannot provide safe ID-based routing.

Target resolution order in broker for a structured target envelope:

1. Exact broker session ID (`target.intercomSessionId`).
2. Exact Pi session ID (`target.piSessionId`).
3. Alias/name lookup constrained by namespace when namespace provided.
4. Existing global name lookup only for compatibility/manual use.

For plain string manual targets, broker should keep existing behavior but must never auto-pick among duplicates. More than one candidate in scope returns deterministic error with candidate IDs/names/cwds.

Namespace is not required for exact ID routes. Namespace exists only to reduce accidental manual name collisions.

### Runtime registration

`IntercomRuntime.buildRegistration()` should produce:

```ts
{
  piSessionId: runtime.piSessionId,
  protocolVersion: 2,
  capabilities: ["piSessionId-routing"],
  namespace: runtime.namespace, // usually undefined; set only when caller needs scoped name lookup
  name: runtime.aliasOrUserFacingName,
  cwd: runtime.ctx.cwd ?? process.cwd(),
  model,
  pid: process.pid,
  startedAt: runtime.startedAt,
  lastActivity: Date.now(),
  status,
}
```

Alias should be deterministic enough for diagnostics but not primary route:

```ts
pi-parent-${shortHash(piSessionId)}
```

Existing display names may still appear in `intercom list`.

### Subagent bridge target

Replace string-only `orchestratorTarget` in bridge flow with `SupervisorIntercomTarget`.

Parent launch requirement:

1. Resolve parent runtime from current execution context.
2. Call `runtime.ensureConnected("subagent-supervisor")`.
3. If connection fails, fail subagent launch with clear error.
4. Build supervisor target from runtime and active client.
5. Pass supervisor target to child env and runtime prompt metadata.

Child env:

```text
PI_SUBAGENT_SUPERVISOR_PI_SESSION_ID=...
PI_SUBAGENT_SUPERVISOR_INTERCOM_SESSION_ID=...
PI_SUBAGENT_SUPERVISOR_ALIAS=...
PI_SUBAGENT_SUPERVISOR_CWD=...
PI_SUBAGENT_RUN_ID=...
PI_SUBAGENT_CHILD_AGENT=...
PI_SUBAGENT_CHILD_INDEX=...
PI_SUBAGENT_INTERCOM_SESSION_NAME=...
```

`contact_supervisor` reads this descriptor and sends one structured target envelope to broker. Broker owns fallback order (`intercomSessionId` -> `piSessionId` -> alias/name). The child must not duplicate identity fallback logic and must not guess based on visible session list. If broker cannot resolve the envelope, `contact_supervisor` returns explicit failure.

### Subagent control/result event ownership

Subagent intercom relay events must include owning parent Pi session ID:

```ts
interface SubagentIntercomPayload {
  ownerPiSessionId: string;
  runId: string;
  target: {
    intercomSessionId?: string;
    piSessionId?: string;
    alias?: string;
    namespace?: string;
  };
  message: string;
  requestId?: string;
}
```

Event handler rule:

```ts
if (payload.ownerPiSessionId !== runtime.piSessionId) return;
runtime.relaySubagentIntercomPayload(payload);
```

No relay path may use whichever runtime is currently global/latest.

### Receiver sanity guard

Broker-delivered `Message` must carry intended receiver metadata for machine-originated subagent/supervisor traffic. It may be omitted only for manual human-originated sends:

```ts
interface Message {
  id: string;
  timestamp: number;
  replyTo?: string;
  expectsReply?: boolean;
  to?: {
    intercomSessionId?: string;
    piSessionId?: string;
    alias?: string;
  };
  content: {
    text: string;
    attachments?: Attachment[];
  };
}
```

Before UI delivery, runtime checks:

```ts
if (message.to?.piSessionId && message.to.piSessionId !== runtime.piSessionId) {
  runtime.recordDroppedMisroutedMessage(from, message);
  return;
}
```

Broker should already prevent misrouting. Runtime guard is defense-in-depth and diagnostic hook. Dropped-message diagnostics should be structured and bounded: record message id, sender id/name, intended piSessionId, actual runtime piSessionId, timestamp, and reason in a bounded ring buffer or `appendEntry` stream.

## Functional Requirements

1. System must maintain separate `IntercomRuntime` instances per Pi session ID.
2. System must not use module-global current session state for inbound message display.
3. System must register each broker session with `piSessionId`.
4. Broker must resolve exact broker session ID before name lookup.
5. Broker must resolve exact Pi session ID before name lookup.
6. Name lookup must remain available for manual `intercom` usage.
7. Name lookup should respect namespace when caller provides namespace.
8. Parent subagent launch must ensure parent intercom runtime is connected before launching child when bridge is active.
9. Parent subagent launch must fail if bridge is active and parent intercom registration fails.
10. Child `contact_supervisor` must route using supervisor descriptor, not a free-form name string.
11. Broker must apply supervisor target fallback order: `intercomSessionId`, then `piSessionId`, then alias/name.
12. Subagent control/result relay payloads must include `ownerPiSessionId`.
13. Relay handlers must ignore payloads whose owner does not match runtime Pi session ID.
14. Runtime must drop and record any inbound message whose intended `piSessionId` conflicts with runtime Pi session ID.
15. Existing user-facing `intercom list/send/ask/reply/pending/status` should continue working for normal manual use.

## Technical Considerations

### Deep module boundary

`IntercomRuntime` should be deep. It should own:

- broker connection lifecycle
- reconnect/backoff timers
- registration payload construction
- presence sync
- inbound queueing
- reply tracking
- UI delivery
- message receiver validation
- subagent relay handling

Callers should not coordinate these pieces manually. Tool handlers and subagent executor should call intent-level methods.

Good interface examples:

```ts
runtime.getSupervisorTarget(): Promise<SupervisorIntercomTarget>
runtime.sendToSupervisor(metadata, request): Promise<SupervisorReply | DeliveryResult>
runtime.executeIntercomTool(params): Promise<ToolResult>
```

Avoid shallow helper sprawl where callers must remember order:

```ts
await ensureConnected();
const id = client.sessionId;
const alias = buildAlias();
const env = buildEnv(id, alias);
// caller now owns invariants = bad
```

### Locality

Keep routing policy in one place:

- broker target resolution and fallback order inside broker
- runtime ownership inside `IntercomRuntime`
- supervisor target construction inside parent intercom bridge seam
- child `contact_supervisor` sends a structured envelope, not retry policy

Avoid duplicating fallback order across foreground/background/async paths or child/parent tools.

### Compatibility

Because scope is this repo, protocol can evolve. Use protocol version/capabilities so manual intercom can still degrade gracefully where possible. Subagent bridge should not degrade when safe routing is unavailable. Tests should cover manual name send/list behavior to avoid breaking day-to-day intercom use.

### Trust boundary

Supervisor target metadata reaches child through environment variables. Local processes can forge local intercom traffic today; this change does not attempt to make intercom a security boundary. It is an isolation/correctness fix for accidental cross-session leakage. If future threat model requires hostile-local-process protection, add a short-lived run-bound token to `SupervisorIntercomTarget` and validate it before accepting supervisor traffic.

### Error messages

When parent bridge cannot register:

```text
Subagent intercom bridge is active, but parent intercom registration failed: <reason>. Child was not launched because supervisor routing would be unsafe.
```

When child cannot reach supervisor:

```text
Supervisor intercom target is unavailable. Broker could not resolve target envelope: intercomSessionId=<...>, piSessionId=<...>, alias=<...>. Reason: <reason>.
```

## Success Metrics

Implementation succeeds when behavior tests prove:

1. Two Pi sessions in same process each receive only their own intercom messages.
2. Starting session B after session A does not cause session A messages to display in B.
3. Subagent launched from session A contacts only session A while session B is active.
4. Subagent result/control event for owner A is ignored by runtime B.
5. Broker exact `intercomSessionId` routing works despite duplicate names.
6. Broker exact `piSessionId` fallback works when broker ID target is absent but Pi session is connected under new broker ID.
7. Manual name send reports duplicate-name error or respects namespace; it does not silently choose arbitrary session.
8. Parent subagent launch fails when bridge active and parent intercom cannot register.
9. Runtime drops inbound message with mismatched `message.to.piSessionId` and records diagnostic entry.
10. Existing manual `intercom ask/reply/pending` behavior remains intact within one session pair.

## Suggested Test Shape

Use behavior-focused integration tests around public surfaces:

- `intercom` tool execution
- `contact_supervisor` tool execution
- broker send/list behavior
- subagent executor launch behavior

Avoid tests that assert internal helper call order. Internal class methods can change if observable invariants remain.

Key scenarios:

```text
session-scoped runtime does not leak inbound messages across sessions
subagent contact_supervisor routes to delegating session by intercomSessionId
subagent relay event ignored by non-owner runtime
broker routes duplicate names by exact ID and rejects ambiguous manual name
active bridge fails launch when parent intercom unavailable
```

## Acceptance Criteria

1. No module-level mutable singleton in `intercom-public/index.ts` represents current session runtime.
2. All tool handlers select runtime by execution context Pi session ID.
3. Broker `SessionInfo` includes `piSessionId`.
4. Subagent supervisor env includes both `intercomSessionId` and `piSessionId`.
5. `contact_supervisor` sends a structured target envelope and no longer depends on parent display name for normal routing.
6. Event relay payloads are owner-scoped.
7. Tests cover multi-session leakage prevention.
8. Spec goal satisfied without changing packages outside this repository.
