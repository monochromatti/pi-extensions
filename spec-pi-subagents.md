# Spec: Minimal `pi-subagents` Union Extension

## Overview

Create `packages/pi-subagents`, a Pi extension that combines the useful parts of upstream `nicobailon/pi-subagents` and `nicobailon/pi-intercom` into one smaller package.

The package exposes two public tools:

1. `subagent` — delegate work to child Pi agents in single, parallel, or chain execution modes.
2. `intercom` — communicate with other active Pi sessions.

It also registers `contact_supervisor` only for subagent child sessions, so children can ask the parent/orchestrator for decisions or send meaningful progress updates.

This target intentionally omits upstream convenience and high-complexity features:

- No optional prompt shortcuts such as `/parallel-review`, `/parallel-cleanup`, `/parallel-research`, etc.
- No chain files feature: no `chainDir` parameter, no persistent shared chain artifact directory, no `{chain_dir}` template variable.
- No agent/chain management actions.
- No chain clarification TUI.
- No worktree mode.

The result should feel like a small, dependable delegation + session-messaging extension, not a broad workflow framework.

## Source scout summary

### Upstream `pi-subagents`

Relevant source areas:

- `src/extension/index.ts`
  - Registers `subagent` tool.
  - Loads config.
  - Wires async trackers, result watchers, renderers, slash command bridge, notify/control notices.
- `src/extension/schemas.ts`
  - Defines broad tool schema.
  - Includes execution modes, management actions, chain file fields (`chainDir`, `{chain_dir}` descriptions), worktree, clarify, output, model, skill, control.
- `src/runs/foreground/*`
  - Single/parallel/chain execution.
  - Chain execution currently deeply tied to `chainDir` for progress files, relative reads/output, parallel dirs, summaries, and worktree diffs.
- `src/runs/background/*`
  - Async job tracking, status, notify, result watching.
- `src/agents/*`
  - Agent discovery/selection/serialization/management.
  - Target should keep discovery/selection needed for execution, but drop create/update/delete/list management flows unless needed internally.
- `src/intercom/*`
  - Bridge code for result/control intercom between subagents and parent.
- `src/slash/*` and `prompts/*`
  - Slash/prompt shortcut support. Target should not ship prompt shortcuts and should not register those shortcuts.
- `agents/*.md`
  - Built-in agent definitions. Target should ship reduced set.
- `skills/pi-subagents/SKILL.md`
  - User-facing skill docs. Target should rewrite for reduced API.

### Upstream `pi-intercom`

Relevant source areas:

- `index.ts`
  - Registers `intercom` tool.
  - Registers `contact_supervisor` tool.
  - Tracks active session metadata and inbound messages.
  - Handles blocking `ask`/`reply` flows.
  - Supports structured supervisor interview requests.
- `broker/*`
  - Broker process, client, framing, socket path resolution, spawn logic.
  - Target should vendor/copy this tested broker into `packages/pi-subagents`.
- `reply-tracker.ts`
  - Tracks outstanding asks and replies.
- `ui/*`
  - Session list, compose overlay, inline message component.
  - Keep only UI needed by retained tool behavior.
- `skills/pi-intercom/SKILL.md`
  - Merge essential docs into `pi-subagents` skill docs.

## Goals

1. Provide one package named `pi-subagents` under `packages/pi-subagents`.
2. Expose `subagent` and `intercom` as public tools.
3. Make `contact_supervisor` available only when current Pi process is a subagent child with required supervisor environment metadata.
4. Support `subagent` execution modes:
   - single
   - parallel
   - chain
5. Support subagent async control:
   - start async run
   - inspect status
   - interrupt run
   - resume run
6. Support forked/fresh context selection.
7. Support output files where explicitly requested on single tasks, parallel tasks, and chain steps.
8. Support model and skill overrides for tasks/steps.
9. Vendor the `pi-intercom` broker into this package; no runtime dependency on separate `pi-intercom` package.
10. Ship minimal built-in agents and one skill doc.
11. Keep implementation small enough to maintain inside this monorepo.

## Non-goals

1. Do not ship or register optional prompt shortcuts:
   - `/parallel-review`
   - `/parallel-cleanup`
   - `/parallel-research`
   - `/parallel-context-build`
   - `/parallel-handoff-plan`
   - similar prompt-template shortcuts
2. Do not support chain files:
   - no `chainDir` user parameter
   - no `{chain_dir}` substitution
   - no shared chain artifact folder exposed to children
   - no `progress.md` chain file contract
3. Do not implement agent or chain management actions:
   - no `action: list/get/create/update/delete`
   - no `chainName`
   - no `config` agent/chain creation schema
4. Do not implement chain clarification TUI.
5. Do not implement worktree execution.
6. Do not depend on separate `pi-intercom` package.
7. Do not preserve upstream API compatibility for removed features.

## Package layout

Target layout:

```text
packages/pi-subagents/
  README.md
  package.json
  index.ts                      # extension entrypoint, or src/extension/index.ts if package mirrors upstream
  src/
    extension/
      index.ts                  # registers tools/events
      schemas.ts                # reduced schemas
    runs/
      foreground/
        execution.ts
        single-execution.ts
        parallel-execution.ts
        chain-execution.ts
        subagent-executor.ts
      background/
        async-job-tracker.ts
        notify.ts
        result-watcher.ts
        run-status.ts
      shared/
        pi-args.ts
    agents/
      agents.ts                 # discovery/selection only
      agent-selection.ts
      agent-scope.ts
      frontmatter.ts
      skills.ts
    intercom/
      index.ts                  # tool registration helpers extracted from upstream pi-intercom index.ts
      reply-tracker.ts
      broker/
        broker.ts
        client.ts
        framing.ts
        paths.ts
        spawn.ts
      ui/
        inline-message.ts
        session-list.ts
        compose.ts
    shared/
      artifacts.ts              # debug/session artifacts only, not chain files
      fork-context.ts
      formatters.ts
      session-identity.ts
      session-tokens.ts
      types.ts
      utils.ts
  agents/
    worker.md
    reviewer.md
    researcher.md
    planner.md
  skills/
    pi-subagents/
      SKILL.md
```

Exact layout can follow upstream if simpler, but package must keep public assets minimal: extension, skill, minimal agents. No `prompts/` directory.

## Public tool API

### `subagent` tool

#### Execution modes

The tool has mutually exclusive execution modes:

1. Single mode: `agent` plus optional `task`.
2. Parallel mode: `tasks` array.
3. Chain mode: `chain` array.
4. Control mode: `action` in `status | interrupt | resume`.

#### Single mode parameters

- `agent: string` — agent name.
- `task?: string` — task to run. Optional for self-contained agents.
- `context?: "fresh" | "fork"` — execution context.
- `cwd?: string` — child working directory.
- `async?: boolean` — run in background.
- `output?: string | false` — explicit output file. Relative paths resolve against `cwd` or parent cwd, not chain dir.
- `outputMode?: "inline" | "file-only"`.
- `skill?: string | string[] | boolean`.
- `model?: string`.
- `sessionDir?: string`.
- `share?: boolean`.
- `includeProgress?: boolean`.
- `control?: ControlOverrides`.

#### Parallel mode parameters

- `tasks: Array<ParallelTask>`.
- `concurrency?: number`.
- `context?: "fresh" | "fork"`.
- `cwd?: string`.
- `async?: boolean`.
- `sessionDir?: string`.
- `share?: boolean`.
- `includeProgress?: boolean`.
- `control?: ControlOverrides`.

`ParallelTask`:

- `agent: string`.
- `task: string`.
- `cwd?: string`.
- `count?: number`.
- `output?: string | false`.
- `outputMode?: "inline" | "file-only"`.
- `reads?: string[] | false` — files resolved relative to task cwd.
- `skill?: string | string[] | boolean`.
- `model?: string`.

No `worktree` parameter.

#### Chain mode parameters

- `chain: Array<ChainStep>`.
- `context?: "fresh" | "fork"`.
- `cwd?: string`.
- `async?: boolean`.
- `sessionDir?: string`.
- `share?: boolean`.
- `includeProgress?: boolean`.
- `control?: ControlOverrides`.

`ChainStep` supports either a sequential step or an embedded parallel step.

Sequential step:

- `agent: string`.
- `task?: string`.
- `cwd?: string`.
- `output?: string | false`.
- `outputMode?: "inline" | "file-only"`.
- `reads?: string[] | false`.
- `skill?: string | string[] | boolean`.
- `model?: string`.

Embedded parallel step:

- `parallel: Array<ParallelTaskInChain>`.
- `concurrency?: number`.
- `failFast?: boolean`.

`ParallelTaskInChain`:

- `agent: string`.
- `task?: string`.
- `cwd?: string`.
- `count?: number`.
- `output?: string | false`.
- `outputMode?: "inline" | "file-only"`.
- `reads?: string[] | false`.
- `skill?: string | string[] | boolean`.
- `model?: string`.

Task template variables:

- `{task}` — original top-level task/request when available.
- `{previous}` — previous step output text.

Removed template variable:

- `{chain_dir}` — must not be documented or substituted. If present in input text, leave literal or return validation error. Recommendation: validation error with message `chain_dir template variable is not supported`.

#### Control mode parameters

- `action: "status" | "interrupt" | "resume"`.
- `id?: string` — run id or prefix.
- `runId?: string` — alias/legacy target id if needed.
- `dir?: string` — async run directory.
- `index?: number` — child index for multi-child run.
- `message?: string` — resume follow-up message.

No management actions.

### `intercom` tool

Retain upstream public actions:

- `list` — list active sessions.
- `send` — send message to session.
- `ask` — send message and wait for reply.
- `reply` — reply to pending ask.
- `pending` — list pending inbound asks.
- `status` — show broker/client status.

Parameters:

- `action: string`.
- `to?: string`.
- `message?: string`.
- `attachments?: Attachment[]`.
- `replyTo?: string`.

Retain inline display of inbound intercom messages if reasonably reusable from upstream.

### `contact_supervisor` tool

Register only when all required child env vars exist:

- `PI_SUBAGENT_ORCHESTRATOR_TARGET`
- `PI_SUBAGENT_RUN_ID`
- `PI_SUBAGENT_CHILD_AGENT`
- `PI_SUBAGENT_CHILD_INDEX`

Optional env var:

- `PI_SUBAGENT_INTERCOM_SESSION_NAME`

Supported reasons:

- `need_decision` — blocking ask; waits for supervisor reply.
- `progress_update` — non-blocking send.
- `interview_request` — blocking structured request.

Do not expose as normal top-level public tool outside child sessions.

## Chain behavior without chain files

1. Chain step N receives previous step output through `{previous}` substitution only.
2. Chain step 1 may use explicit `task`; if omitted, validation should fail unless agent is self-contained and design explicitly permits it.
3. Parallel chain step receives same `{previous}` input for all children unless each child task overrides.
4. Outputs are collected in memory and summarized in final result.
5. Explicit `output` writes are allowed:
   - absolute path: write exactly there
   - relative path: resolve against step `cwd` if set, else top-level `cwd`, else parent process cwd
6. `reads` paths resolve similarly against step/task cwd.
7. Debug/session artifacts may exist internally for logs/results, but child prompts must not know or rely on a shared chain directory.
8. No `progress.md` file contract. Progress shown via tool updates/events only.

## Async behavior

1. `async: true` starts run in background and returns run metadata immediately.
2. Background runs write internal result/status artifacts under session-derived or temp directories.
3. `subagent({ action: "status", id })` reports current state and recent output.
4. `subagent({ action: "interrupt", id })` softly interrupts target run.
5. `subagent({ action: "resume", id, message, index? })` resumes paused/background child session when supported by Pi runtime.
6. Completion/failure should emit existing subagent async events where possible.
7. Async result delivery over intercom should continue if already wired in upstream and compatible with reduced scope.

## Context behavior

1. `context: "fresh"` starts child without parent transcript context except task/instructions.
2. `context: "fork"` branches from parent context using upstream fork-context support.
3. If omitted, default should follow agent default context if available; otherwise fresh.
4. Child env must include subagent metadata needed for `contact_supervisor` and run tracking.

## Built-in agents

Ship only:

1. `worker.md` — general implementation/execution agent.
2. `reviewer.md` — review and critique agent.
3. `researcher.md` — codebase/web/library research agent.
4. `planner.md` — planning/spec decomposition agent.

Do not ship upstream `oracle`, `delegate`, `context-builder`, `scout` unless implementation discovers hard dependency. If a hidden internal context-builder is required, keep it internal and undocumented.

## Skill docs

Create one skill: `skills/pi-subagents/SKILL.md`.

It should document:

- when to use subagents
- single/parallel/chain examples
- async status/interrupt/resume examples
- intercom examples
- child `contact_supervisor` behavior
- removed features/non-supported patterns

It must not mention shortcut prompts or chain files.

## Implementation approach

### Phase 1: Scaffold package

1. Create `packages/pi-subagents/package.json`.
2. Match monorepo style from existing packages.
3. Add `pi.extensions` entry pointing at extension entrypoint.
4. Add `pi.skills` entry pointing at `skills`.
5. Add files list for `src`, `agents`, `skills`, README.
6. Depend on `typebox` and Pi peer dependencies as needed.

### Phase 2: Import and reduce `pi-subagents`

1. Copy upstream execution, shared, agent discovery, render, and async files needed for retained scope.
2. Remove imports and call sites for:
   - `registerSlashCommands`
   - prompt template bridge
   - slash live state/rendering if unused
   - chain clarify TUI
   - agent management handlers
   - worktree execution
3. Reduce schema to retained API.
4. Remove `chainDir` from params and all descriptions.
5. Remove `{chain_dir}` replacement.
6. Change relative `output`/`reads` path resolution to cwd-based behavior.
7. Replace chain progress files with in-memory progress updates.
8. Keep internal artifacts only for debugging/status where needed.

### Phase 3: Vendor intercom

1. Copy upstream `pi-intercom` broker, client, framing, paths, spawn.
2. Copy `reply-tracker` and required types.
3. Extract `intercom` tool registration into function, e.g. `registerIntercomTool(pi, state)`.
4. Extract `contact_supervisor` registration into function gated by child env metadata.
5. Share one broker/client state between `intercom`, `contact_supervisor`, and subagent result/control bridge.
6. Preserve blocking ask/reply semantics.

### Phase 4: Wire subagent + intercom

1. Parent subagent runs should set env vars for child:
   - supervisor target
   - run id
   - child agent name
   - child index
   - child intercom session name if known
2. Child sessions should receive instructions for `contact_supervisor` use.
3. Result/control intercom events should still reach parent session when enabled.
4. Ensure foreground execution does not hang when child uses intercom/contact_supervisor.

### Phase 5: Assets/docs/tests

1. Add four built-in agents.
2. Add merged skill doc.
3. Add README with install and examples.
4. Add unit tests for reduced schema.
5. Add integration tests for:
   - single run
   - parallel run
   - chain run with `{previous}`
   - chain rejects `{chain_dir}`
   - explicit output path resolution
   - async status/interrupt/resume smoke tests
   - intercom list/send/ask/reply
   - child-only `contact_supervisor` registration
   - package manifest excludes `prompts/`

## Validation rules

1. Exactly one execution mode per `subagent` call:
   - single: `agent`
   - parallel: `tasks`
   - chain: `chain`
   - control: `action`
2. `action` must be one of `status`, `interrupt`, `resume`.
3. Reject removed fields with clear errors:
   - `chainDir`
   - `worktree`
   - `clarify`
   - management `config`
   - `chainName`
4. Reject unsupported actions:
   - `list`
   - `get`
   - `create`
   - `update`
   - `delete`
   - `doctor` unless explicitly retained later
5. Reject task templates containing `{chain_dir}`.
6. `outputMode: "file-only"` requires `output` path.
7. `concurrency` must be >= 1.
8. `count` must be >= 1.

## Error messages

Use direct, actionable errors:

- `chainDir is not supported; use explicit output paths instead`
- `{chain_dir} template variable is not supported; use {previous} or explicit output files`
- `worktree mode is not supported by this pi-subagents package`
- `agent management actions are not supported`
- `contact_supervisor is only available inside subagent child sessions`

## Success criteria

1. `npm test` or package test command passes.
2. `package.json` for `packages/pi-subagents` has no `prompts` entry in `pi` metadata and no `prompts/` in packaged files.
3. `subagent` tool schema does not contain `chainDir`, `worktree`, `clarify`, management actions, or `{chain_dir}` docs.
4. Single execution works with built-in `worker`.
5. Parallel execution runs multiple child agents and returns combined results.
6. Chain execution passes `{previous}` between steps.
7. Chain execution with `{chain_dir}` fails validation.
8. Explicit output files write to cwd-relative or absolute paths.
9. Async run can be started and inspected by id.
10. Interrupt/resume control path works or returns clear runtime-supported error.
11. `intercom` can list sessions and send/ask/reply between two Pi sessions.
12. `contact_supervisor` is absent in normal sessions and present in child sessions.
13. Built-in agents discovered: `worker`, `reviewer`, `researcher`, `planner`.
14. Skill docs match reduced API.

## Open implementation notes

- Upstream `chain-execution.ts` is heavily coupled to `chainDir`. Expect significant simplification rather than surgical deletion.
- Consider making chain execution pure around an in-memory `ChainRunState`, then attach async/artifact persistence outside it.
- Intercom upstream `index.ts` is large; split while importing to avoid one giant extension file.
- Avoid global state collisions if multiple Pi sessions load same extension. Broker paths/session IDs from upstream should be reused.
- Keep old upstream tests as source reference, but write target tests around reduced behavior rather than preserving deleted APIs.
