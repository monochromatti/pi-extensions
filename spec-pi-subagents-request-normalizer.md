# Spec: pi-subagents request normalizer and executor split

## Overview

`packages/pi-subagents/src/runs/foreground/subagent-executor.ts` is still the main shallow Module after child-run preparation refactor. It mixes raw public params, action routing, mode detection, count expansion, default context, agent validation, depth handling, bridge setup, and execution routing.

This refactor introduces a deeper **Module**: `SubagentRequestNormalizer`. It turns raw `subagent` tool params into a validated discriminated request. The executor keeps lifecycle/spawn/result behavior, but stops re-deriving basic request facts.

Goal: simpler executor, clearer **Interface**, better **Locality**, no behavior change.

## Decisions from review

1. Management actions (`status`, `resume`, `interrupt`) must continue to bypass nesting-depth blocking and agent discovery where possible.
2. Public unknown action behavior must remain schema-driven: `action must be one of: status, interrupt, resume`.
3. Use a two-phase normalization seam. Single monolithic normalizer was too ambiguous because cwd, agent discovery, default context, and intercom bridge depend on each other.
4. Do not move resume follow-up validation in first pass. Keep `resumeAsyncRun` behavior unless tests characterize exact result first.
5. Do not move file-only output validation in this pass.
6. Move shared request types out of `subagent-executor.ts` to avoid circular imports.

## Architecture vocabulary

- **Module**: `SubagentRequestNormalizer` hides schema-adjacent semantic rules.
- **Interface**: raw params enter once; executor receives `NormalizedControlRequest` or `NormalizedRunRequest`.
- **Seam**: sits between public tool input/schema validation and execution orchestration.
- **Adapter**: TypeBox schema validation remains structural public-input adapter.
- **Depth**: caller gets cwd resolution, action/run discrimination, count expansion, async override, default context, and agent validation from narrow functions.
- **Leverage**: status/resume/interrupt and run modes use trusted shapes instead of broad `SubagentParamsLike`.
- **Locality**: future public option/mode rule changes land in schema + normalizer.

## Goals

1. Add focused request-normalization Modules and tests.
2. Reduce direct validation/defaulting/count-expansion logic in `subagent-executor.ts`.
3. Preserve current behavior and error text.
4. Keep executor responsible for session/artifact/control/intercom setup and run execution.
5. Keep refactor incremental; no `PiChildRunner`, no async store, no broad intercom split.

## Non-goals

1. No public schema changes.
2. No execution semantics changes.
3. No output/session/artifact/control/intercom behavior changes.
4. No spawn, JSONL, progress, model fallback, result formatting refactor.
5. No broad `async-execution.ts` refactor.
6. No `shared/types.ts` split.
7. No command router or foreground registry unless normalizer is green and executor still has obvious low-risk extraction.

## Proposed files

Add:

- `packages/pi-subagents/src/runs/foreground/subagent-request-types.ts`
- `packages/pi-subagents/src/runs/foreground/subagent-request-normalizer.ts`
- `packages/pi-subagents/test/unit/subagent-request-normalizer.test.ts`

Move/re-export:

- `SubagentParamsLike`
- `TaskParam`

from `subagent-request-types.ts`. `subagent-executor.ts` should re-export them if external imports rely on current path.

Do **not** make normalizer import from `subagent-executor.ts`; executor imports normalizer, so that would create circular coupling.

## Current behavior to preserve

### Current executor order

Preserve behavior implied by current order:

1. Validate raw params with `validateSubagentParams(params)`.
2. Resolve requested cwd from raw params after schema validation, before passing params onward.
3. If `params.action`, handle `status`, `resume`, `interrupt` before depth check.
4. Only run requests hit `checkSubagentDepth` blocking.
5. For run requests: expand counts.
6. Apply force-top-level-async override.
7. Discover agents at effective cwd.
8. Apply agent default context.
9. Resolve intercom bridge from effective context.
10. Wrap agents if bridge active.
11. Validate execution input against effective agents.
12. Build session/artifact/control context.
13. Route async/chain/parallel/single.

Important: management actions must not require agent discovery/default context/bridge.

### Schema vs semantic validation

`validateSubagentParams(rawParams)` remains first structural adapter. Do not validate cwd-resolved mutated params.

Public unknown action must remain schema error:

```txt
action must be one of: status, interrupt, resume
```

Executor’s old defensive unknown-action branch may remain unreachable or be removed only if tests prove schema covers it.

### Depth behavior

`checkSubagentDepth` stays in executor for now.

- Control requests bypass depth block.
- Run requests are blocked when current depth exceeds max.
- Normalizer receives `depth` only to apply `applyForceTopLevelAsyncOverride` for run requests.

## New request types

### Control requests

```ts
export type NormalizedControlRequest =
  | NormalizedStatusRequest
  | NormalizedInterruptRequest
  | NormalizedResumeRequest;

export interface NormalizedRequestBase {
  params: SubagentParamsLike;
  requestedCwd: string; // absolute
  effectiveCwd: string; // absolute; equals params.cwd ?? runtime cwd for this pass
  context?: "fresh" | "fork";
}

export interface NormalizedStatusRequest extends NormalizedRequestBase {
  kind: "status";
  id?: string;
  runId?: string;
  dir?: string;
}

export interface NormalizedInterruptRequest extends NormalizedRequestBase {
  kind: "interrupt";
  targetRunId?: string; // runId ?? id
}

export interface NormalizedResumeRequest extends NormalizedRequestBase {
  kind: "resume";
  id?: string;
  runId?: string;
  index?: number;
  // Do not require validated followUp yet; resumeAsyncRun still owns exact error behavior.
}
```

### Run requests

```ts
export type NormalizedRunRequest =
  | NormalizedSingleRunRequest
  | NormalizedParallelRunRequest
  | NormalizedChainRunRequest;

export interface NormalizedRunBaseRequest extends NormalizedRequestBase {
  kind: "run";
  mode: "single" | "parallel" | "chain";
  effectiveAsync: boolean;
  shareEnabled: boolean;
  control?: ControlConfig;
  sessionDir?: string;
  maxOutput?: MaxOutputConfig;
  includeProgress?: boolean;
}

export interface NormalizedSingleRunRequest extends NormalizedRunBaseRequest {
  mode: "single";
  agent: string;
  task: string; // normalized from params.task ?? "" to preserve current single-run behavior
  model?: string;
  skill?: string | string[] | boolean;
  output?: string | boolean;
  outputMode?: "inline" | "file-only";
}

export interface NormalizedParallelRunRequest extends NormalizedRunBaseRequest {
  mode: "parallel";
  tasks: TaskParam[]; // count removed after expansion
  concurrency?: number;
}

export interface NormalizedChainRunRequest extends NormalizedRunBaseRequest {
  mode: "chain";
  chain: ChainStep[]; // embedded parallel count removed after expansion
  task?: string;
  skill?: string | string[] | boolean;
}
```

## Normalizer Interfaces

Use surface normalization plus explicit run phases, not one giant function.

### 1. Surface normalization

```ts
export function normalizeSubagentSurfaceRequest(input: NormalizeSurfaceInput): NormalizeSurfaceResult;

export interface NormalizeSurfaceInput {
  rawParams: SubagentParamsLike;
  runtimeCwd: string;
}

export type NormalizeSurfaceResult =
  | { ok: true; request: SurfaceControlRequest | SurfaceRunRequest }
  | { ok: false; result: AgentToolResult<Details> };
```

Responsibilities:

1. Call `validateSubagentParams(rawParams)`.
2. Resolve `requestedCwd` absolute.
3. Return control request immediately when `action` is present.
4. Return surface run request with cwd-resolved params, but without agent validation/default context.

Do not require agents. Do not check nesting depth. Do not discover agents.

### 2. Run normalization phases

Do not implement a monolithic `normalizeSubagentRunRequest` in this pass. Implement these primary Interfaces:

```ts
export function normalizeSubagentRunShape(input: NormalizeRunShapeInput): NormalizeRunShapeResult;
export function applyDefaultContextToRunShape(shape: NormalizedRunShape, agents: AgentConfig[]): NormalizedRunShape;
export function validateSubagentRunRequest(input: ValidateRunRequestInput): NormalizeRunResult;
```

Responsibilities, preserving current order:

1. `normalizeSubagentRunShape`: expand repeated counts, apply force-top-level-async override, compute `effectiveAsync`, determine semantic mode. No agents. No default context.
2. `applyDefaultContextToRunShape`: apply default context after count expansion/async override succeeds and before bridge resolution.
3. `validateSubagentRunRequest`: validate mode and agent references using bridge-wrapped `executionAgents`, then return final `NormalizedRunRequest`.

## Detailed behavior

### Surface normalization

#### Schema validation

Current schema tests remain source of truth. If invalid:

```ts
{
  content: [{ type: "text", text: validation.error ?? "Invalid subagent parameters" }],
  isError: true,
  details: { mode: "single", results: [] }
}
```

#### Cwd

```ts
requestedCwd = rawParams.cwd ? path.resolve(runtimeCwd, rawParams.cwd) : runtimeCwd;
params = rawParams.cwd === undefined ? rawParams : { ...rawParams, cwd: requestedCwd };
effectiveCwd = params.cwd ?? runtimeCwd;
```

Both cwd values must be absolute.

#### Control request routing

If `params.action === "status"`, return `kind: "status"`.

If `params.action === "interrupt"`, return `kind: "interrupt"`, `targetRunId = params.runId ?? params.id`.

If `params.action === "resume"`, return `kind: "resume"` without validating message/task. Existing `resumeAsyncRun` keeps exact follow-up validation:

```txt
action='resume' requires message.
```

### Run normalization

#### Ownership and ordering

Run normalization is split into three run-specific helpers to preserve current ordering:

1. `normalizeSubagentRunShape(surface, depth, asyncByDefault, forceTopLevelAsync)`
   - expands counts
   - applies top-level async override
   - computes `effectiveAsync`
   - determines mode from expanded params
   - does **not** apply default context
   - does **not** need agents
2. `applyDefaultContextToRunShape(shape, defaultContextAgents)`
   - applies `applyAgentDefaultContext` only after count expansion has succeeded
   - needed before bridge resolution
3. `validateSubagentRunRequest(shapeWithContext, executionAgents)`
   - validates mode-specific agent/chain rules after bridge-wrapped execution agents exist
   - returns final `NormalizedRunRequest`

This replaces the earlier idea that `normalizeSubagentRunRequest` owns everything. Implementation may expose one convenience function later, but first pass should keep these phases explicit.

#### Count expansion

Move or copy these existing helpers into normalizer and export them during transition:

- `expandTopLevelTaskCounts`
- `normalizeRepeatedParallelCounts`

Embedded helper may remain private:

- `expandChainParallelCounts`

Rules:

- `tasks[].count` must be integer >= 1.
- `chain[].parallel[].count` must be integer >= 1.
- expanded task objects must omit `count`.
- order preserved.

Preserve errors:

```txt
tasks[<i>].count must be an integer >= 1
chain[<step>].parallel[<i>].count must be an integer >= 1
```

Preserve current fork-context behavior for count errors. Characterize with tests before changing:

- explicit `context: "fork"` should include fork details if current helper does.
- default-context fork should not be added to count errors if current ordering did not apply default context yet.

#### Async override

Apply:

```ts
applyForceTopLevelAsyncOverride(params, depth, forceTopLevelAsync)
```

Then compute:

```ts
effectiveAsync = params.async ?? asyncByDefault;
```

Characterize helper behavior before moving. Tests should cover:

- depth 0 + force true
- depth > 0 + force true
- explicit `async: false` + force true
- explicit `async: true` + force true

#### Default context

Preserve existing rule:

- explicit `context` wins.
- if no explicit context and any selected known agent has `defaultContext: "fork"`, set `context: "fork"`.
- unknown agent names are ignored for context selection, then reported during validation.

Keep `applyAgentDefaultContext` exported, but move definition to normalizer or request-types module if needed. Executor can re-export temporarily.

#### Mode detection

Use same semantic mode as current executor after schema validation/count expansion:

```ts
hasChain = (params.chain?.length ?? 0) > 0;
hasTasks = (params.tasks?.length ?? 0) > 0;
hasSingle = !hasChain && !hasTasks && Boolean(params.agent);
```

Exactly one must be true.

Preserve error:

```txt
Provide exactly one mode. Agents: <names-or-none>
```

Important: schema also checks exact-one-mode by property presence (`action`, `agent`, `tasks`, `chain`). Do not replace schema behavior. Add characterization tests for empty arrays (`tasks: []`, `chain: []`) and preserve observed errors.

#### Agent and chain validation

Move current `validateExecutionInput` logic to normalizer.

Preserve:

- unknown single agent: `Unknown agent: <name>`
- unknown parallel task agent: `Unknown agent: <name> (task <n>)`
- empty chain if currently reachable: `Chain must have at least one step`
- first parallel chain step missing task: `First parallel step: task <n> must have a task (no previous output to reference)`
- first sequential chain step missing task and no top-level task: `First step in chain must have a task`
- unknown chain agent: `Unknown agent: <name> (step <n>)`
- empty embedded parallel step: `Parallel step <n> must have at least one task`

Do not add fork context to unknown-agent errors unless characterization shows current behavior does.

#### Output validation stays out

Do not move:

- `validateFileOnlyOutputMode`
- `resolveSingleOutputPath`
- duplicate parallel output detection

Those need cwd/output/agent-default details and belong in existing run paths for this pass.

## Executor target flow

Pseudo target shape:

```ts
const surface = normalizeSubagentSurfaceRequest({ rawParams: params, runtimeCwd: ctx.cwd });
if (!surface.ok) return surface.result;

if (surface.request.kind === "status") {
  const foreground = getForegroundControl(deps.state, surface.request.id ?? surface.request.runId);
  if (foreground) return foregroundStatusResult(foreground);
  return inspectSubagentStatus(surface.request.params);
}

if (surface.request.kind === "resume") {
  return resumeAsyncRun({ params: surface.request.params, requestCwd: surface.request.requestedCwd, ctx, deps });
}

if (surface.request.kind === "interrupt") {
  return interruptByTarget(surface.request.targetRunId);
}

// run request only from here
const { blocked, depth, maxDepth } = checkSubagentDepth(deps.config.maxSubagentDepth);
if (blocked) return currentDepthBlockedError;

// Count expansion/async override happen before agent discovery to preserve current error behavior.
const shape = normalizeSubagentRunShape({
  surface: surface.request,
  depth,
  asyncByDefault: deps.asyncByDefault,
  forceTopLevelAsync: deps.config.forceTopLevelAsync === true,
});
if (!shape.ok) return shape.result;

let discoveredAgents = deps.discoverAgents(shape.request.effectiveCwd, "both").agents;
const contextShape = applyDefaultContextToRunShape(shape.request, discoveredAgents);

const intercomBridge = resolveIntercomBridge({ context: contextShape.context, ... });
const executionAgents = intercomBridge.active
  ? discoveredAgents.map((agent) => applyIntercomBridgeToAgent(agent, intercomBridge))
  : discoveredAgents;

const normalized = validateSubagentRunRequest({
  shape: contextShape,
  executionAgents,
});
if (!normalized.ok) return normalized.result;

switch (normalized.request.mode) {
  case "single": ...
  case "parallel": ...
  case "chain": ...
}
```

Implementation may instead add a tiny helper `applyDefaultContextToSurfaceRunRequest` exported from normalizer so default context is not duplicated.

## Implementation sequence

### RED 1: characterization tests

Before moving logic, add tests for current behavior where spec risk exists:

1. `action: "bad"` returns schema error `action must be one of: status, interrupt, resume`.
2. Management actions bypass depth block. Use existing integration/mocks if possible:
   - `action: "status"` at max depth does not return nested-depth block.
   - `action: "interrupt"` at max depth does not return nested-depth block.
   - `action: "resume"` at max depth reaches existing resume handling (including missing-message error) rather than nested-depth block.
3. Management actions do not call `discoverAgents` for `status`, `interrupt`, or missing-message `resume`.
4. `action: "resume", task: "follow up"` is accepted by schema and reaches resume behavior.
5. Empty arrays:
   - `{ tasks: [] }`
   - `{ chain: [] }`
   Capture current expected errors.
6. Count error fork context with explicit fork.
7. Count error with default-context fork agent. Confirm whether default context appears. Preserve result.
8. Unknown-agent error context behavior. Preserve result.

### RED 2: normalizer unit tests

Add `subagent-request-normalizer.test.ts` for pure functions:

1. surface single request resolves cwd absolute.
2. surface status request does not need agents.
3. surface interrupt computes `targetRunId`.
4. surface resume does not reject missing message.
5. run normalization expands top-level count, strips `count`, preserves order.
6. run normalization expands embedded parallel count, strips `count`, preserves order.
7. invalid counts return current mode-specific errors.
8. default context becomes fork for selected fork-default agent.
9. explicit context preserved.
10. unknown selected agent does not get context just because another unselected agent defaults fork.
11. force-top-level-async behavior matches characterization.
12. unknown single/parallel/chain agents preserve messages.
13. first chain step rules preserve messages.
14. normalized request discriminants are correct for single/parallel/chain.

### GREEN 1: add request types

Create `subagent-request-types.ts`.

Move `TaskParam` and `SubagentParamsLike` definitions there. Re-export from executor:

```ts
export type { SubagentParamsLike, TaskParam } from "./subagent-request-types.ts";
```

Update imports if needed.

### GREEN 2: implement surface normalizer

Create `subagent-request-normalizer.ts` with `normalizeSubagentSurfaceRequest`.

Keep executor behavior unchanged except replacing initial schema/action/cwd code with surface request if easy. If not, first land pure module/tests only.

### GREEN 3: implement run shape/context/validation helpers

Implement explicit phases:

- `normalizeSubagentRunShape`
- `applyDefaultContextToRunShape`
- `validateSubagentRunRequest`

Move existing helpers:

- `getRequestedModeLabel`
- `buildRequestedModeError`
- `withForkContext` equivalent local helper
- `applyAgentDefaultContext`
- `expandTopLevelTaskCounts`
- `normalizeRepeatedParallelCounts`
- `validateExecutionInput`

Keep exports stable. Executor can import from normalizer. Do not let `validateSubagentRunRequest` re-apply default context.

### GREEN 4: route executor through normalized run request

Update `createSubagentExecutor.execute`:

- management action branch consumes `SurfaceControlRequest`.
- depth check only runs for surface run request.
- run setup uses `NormalizedRunRequest`.
- use `request.mode` instead of recomputing mode for top-level route.
- keep `ExecutionContextData.params` as `request.params` to reduce churn.

### REFACTOR 5: delete duplicate helper definitions from executor

Acceptance:

```bash
rg "function validateExecutionInput|function normalizeRepeatedParallelCounts|function expandTopLevelTaskCounts|function applyAgentDefaultContext" packages/pi-subagents/src/runs/foreground/subagent-executor.ts
```

Expected: no matches.

A few `hasChain/hasTasks/hasSingle` checks may remain inside path-specific logic temporarily, but top-level validation should not live in executor.

## Test commands

Run after each GREEN slice if cheap:

```bash
npm test -w pi-subagents
```

Final:

```bash
npm test -w pi-subagents
node --experimental-transform-types --input-type=module -e "import './packages/pi-subagents/src/extension/index.ts'; console.log('ok')"
npm run check
```

## Risks

1. **Management action regression**: status/resume/interrupt must bypass depth and agent discovery behavior.
2. **Bridge ordering**: default context must be known before `resolveIntercomBridge`.
3. **Circular imports**: request types must not remain solely in executor if normalizer imports them.
4. **Schema-vs-semantic errors**: preserve public schema errors, especially unknown action and mixed mode.
5. **Fork-context error details**: characterize before changing order.
6. **Empty arrays**: current behavior must be tested before encoding assumptions.
7. **Resume task/message**: action resume may use `task`; do not let run-mode validation reject it.

## Success criteria

1. `subagent-request-types.ts` and `subagent-request-normalizer.ts` exist.
2. Normalizer unit tests cover action/run discrimination, cwd, counts, default context, async override, and agent/chain validation.
3. `subagent-executor.ts` no longer defines count expansion, default-context selection, or execution-input validation helpers.
4. Management actions still work at max subagent depth and do not discover agents when not needed.
5. Public error messages remain stable.
6. All validation commands pass.

## Recommendation

Implement only through GREEN 4 first. Stop before optional router/registry. Biggest gain comes from making request shape explicit and moving shallow validation/defaulting out of executor; further extraction can happen after behavior is pinned.
