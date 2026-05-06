# Implementation plan for pi-subagents

Goal: build `packages/pi-subagents`, a minimal union of upstream `pi-subagents` and `pi-intercom`. It should expose `subagent` and `intercom`, register `contact_supervisor` only in child sessions, support single/parallel/chain delegation plus async status/interrupt/resume, and omit shortcuts, chain files, agent management, TUI clarify, and worktrees.

Plan uses vertical RED→GREEN slices. Each slice starts with one behavior test through package/tool public behavior, then minimum implementation.

## Relevant files

- `spec-pi-subagents.md` - Source spec for target behavior and non-goals.
- `packages/pi-subagents/package.json` - Package manifest, Pi extension/skill metadata, files list.
- `packages/pi-subagents/README.md` - Public usage docs and examples.
- `packages/pi-subagents/src/extension/index.ts` - Main extension entrypoint; registers tools and shared state.
- `packages/pi-subagents/src/extension/schemas.ts` - Reduced public schemas and validation helpers.
- `packages/pi-subagents/test/unit/package-manifest.test.ts` - Behavior tests for package metadata and omitted prompt assets.
- `packages/pi-subagents/test/unit/schemas.test.ts` - Behavior tests for accepted/rejected `subagent` params.
- `packages/pi-subagents/test/integration/single-execution.test.ts` - Public behavior test for single child delegation.
- `packages/pi-subagents/test/integration/parallel-execution.test.ts` - Public behavior test for parallel delegation.
- `packages/pi-subagents/test/integration/chain-execution.test.ts` - Public behavior test for `{previous}` chain handoff and no `{chain_dir}`.
- `packages/pi-subagents/test/integration/async-control.test.ts` - Public behavior tests for async start/status/interrupt/resume.
- `packages/pi-subagents/test/integration/intercom.test.ts` - Public behavior tests for intercom list/send/ask/reply/status.
- `packages/pi-subagents/test/integration/contact-supervisor.test.ts` - Behavior tests for child-only `contact_supervisor` registration and blocking/non-blocking flows.
- `packages/pi-subagents/src/runs/foreground/single-execution.ts` - Single child execution behavior.
- `packages/pi-subagents/src/runs/foreground/parallel-execution.ts` - Parallel child execution behavior.
- `packages/pi-subagents/src/runs/foreground/chain-execution.ts` - Chain orchestration without chain files.
- `packages/pi-subagents/src/runs/foreground/subagent-executor.ts` - Dispatches single/parallel/chain/control execution.
- `packages/pi-subagents/src/runs/background/async-job-tracker.ts` - Background run tracking.
- `packages/pi-subagents/src/runs/background/run-status.ts` - Status inspection and resume/interrupt helpers.
- `packages/pi-subagents/src/runs/background/notify.ts` - Async completion/failure notification integration.
- `packages/pi-subagents/src/runs/shared/pi-args.ts` - Child Pi process args/env, including supervisor metadata.
- `packages/pi-subagents/src/agents/agents.ts` - Built-in/project/user agent discovery for execution.
- `packages/pi-subagents/src/agents/agent-selection.ts` - Agent selection and default context behavior.
- `packages/pi-subagents/src/shared/fork-context.ts` - Forked context support.
- `packages/pi-subagents/src/shared/artifacts.ts` - Internal debug/session artifacts, not chain files.
- `packages/pi-subagents/src/shared/types.ts` - Shared types for runs/results/events.
- `packages/pi-subagents/src/shared/formatters.ts` - Result/status formatting.
- `packages/pi-subagents/src/intercom/index.ts` - Registers `intercom` and child-gated `contact_supervisor`.
- `packages/pi-subagents/src/intercom/reply-tracker.ts` - Ask/reply tracking.
- `packages/pi-subagents/src/intercom/broker/broker.ts` - Vendored intercom broker process.
- `packages/pi-subagents/src/intercom/broker/client.ts` - Broker client used by extension tools.
- `packages/pi-subagents/src/intercom/broker/framing.ts` - Broker protocol framing.
- `packages/pi-subagents/src/intercom/broker/paths.ts` - Broker socket/path helpers.
- `packages/pi-subagents/src/intercom/broker/spawn.ts` - Broker spawn helper.
- `packages/pi-subagents/src/intercom/ui/inline-message.ts` - Inline inbound message rendering.
- `packages/pi-subagents/src/intercom/ui/session-list.ts` - Session list UI if retained.
- `packages/pi-subagents/src/intercom/ui/compose.ts` - Compose UI if retained.
- `packages/pi-subagents/agents/worker.md` - Built-in worker agent.
- `packages/pi-subagents/agents/reviewer.md` - Built-in reviewer agent.
- `packages/pi-subagents/agents/researcher.md` - Built-in researcher agent.
- `packages/pi-subagents/agents/planner.md` - Built-in planner agent.
- `packages/pi-subagents/skills/pi-subagents/SKILL.md` - Reduced user skill docs.

## Instructions for completing tasks

Before starting work, check current state of tasks (find what already completed), and read Notes section.

**IMPORTANT:** As you complete each task, check it off in this markdown file by changing `- [ ]` to `- [x]`. This tracks progress and prevents skipped steps.

Example:
- `- [ ] 1.1 Read file` → `- [x] 1.1 Read file` after completing.

Update file after completing each sub-task, not only after parent task.

If applicable, update Notes section with lessons, discoveries, and design choices useful to next engineer.

## Tasks

- [x] 1.0 Scaffold package and prove package surface
  - [x] 1.1 RED: Add failing package-manifest behavior test asserting `packages/pi-subagents/package.json` exists, registers one extension and one skill directory, has no `pi.prompts`, and packaged files exclude `prompts/`.
  - [x] 1.2 GREEN: Create minimal `packages/pi-subagents/package.json`, extension stub, README stub, skill stub, and four agent files to pass manifest test.
  - [x] 1.3 RED: Add failing behavior test asserting built-in agent files are exactly `worker.md`, `reviewer.md`, `researcher.md`, and `planner.md` for public assets.
  - [x] 1.4 GREEN: Adjust agents directory and package files list so only those built-in agents ship.
  - [x] 1.5 REFACTOR: Align package scripts/dependencies with monorepo style and upstream peer dependency names while keeping tests green.

- [x] 2.0 Define reduced `subagent` public schema and validation
  - [x] 2.1 RED: Add failing schema test accepting single mode with `agent`, optional `task`, `context`, `cwd`, `async`, `output`, `outputMode`, `skill`, and `model`.
  - [x] 2.2 GREEN: Implement reduced schema and validator for single mode.
  - [x] 2.3 RED: Add failing schema test accepting parallel mode with `tasks`, `concurrency`, per-task `reads`, `output`, `skill`, and `model`.
  - [x] 2.4 GREEN: Implement parallel mode schema and validation.
  - [x] 2.5 RED: Add failing schema test accepting chain sequential and embedded parallel steps with `{task}` and `{previous}` descriptions only.
  - [x] 2.6 GREEN: Implement chain schema and template validation for retained variables.
  - [x] 2.7 RED: Add failing schema test rejecting removed fields/actions: `chainDir`, `worktree`, `clarify`, `config`, `chainName`, `action: list/get/create/update/delete/doctor`, and any task containing `{chain_dir}`.
  - [x] 2.8 GREEN: Implement explicit removed-feature validation with spec error messages.
  - [x] 2.9 RED: Add failing schema test for control mode accepting only `status`, `interrupt`, and `resume` plus `id/runId/dir/index/message`.
  - [x] 2.10 GREEN: Implement control mode schema and mutually exclusive execution-mode validation.
  - [x] 2.11 REFACTOR: Keep schema descriptions concise and verify generated tool description contains no `chain_dir`, `chainDir`, `worktree`, or shortcut text.

- [x] 3.0 Port minimal subagent execution core
  - [x] 3.1 RED: Add failing integration test using mock Pi child script: `subagent({agent:"worker", task:"echo hi"})` spawns one child and returns child output.
  - [x] 3.2 GREEN: Port/import minimum agent discovery, child spawn, result parsing, and single execution needed to pass.
  - [x] 3.3 RED: Add failing behavior test asserting `context:"fork"` passes fork context/session args while default remains fresh unless agent default says fork.
  - [x] 3.4 GREEN: Port fork-context support and default context selection.
  - [x] 3.5 RED: Add failing behavior test asserting single `output:"out.txt"` writes relative to `cwd` and `outputMode:"file-only"` returns file reference.
  - [x] 3.6 GREEN: Implement explicit output handling without chain-dir path resolution.
  - [x] 3.7 RED: Add failing behavior test asserting per-run child env includes subagent run metadata needed later by `contact_supervisor`.
  - [x] 3.8 GREEN: Implement child env construction with run id, child index, child agent, and optional supervisor target placeholders.
  - [x] 3.9 REFACTOR: Remove unused upstream imports for slash bridge, prompt templates, chain clarify, management, and worktree from execution path.

- [ ] 4.0 Add parallel execution slices
  - [x] 4.1 RED: Add failing integration test for `subagent({tasks:[...]})` running two mock children and returning combined results in stable task order.
  - [x] 4.2 GREEN: Port/import minimum parallel executor and result aggregation.
  - [x] 4.3 RED: Add failing behavior test for `concurrency: 1` proving second child starts only after first completes.
  - [x] 4.4 GREEN: Implement concurrency limiter.
  - [x] 4.5 RED: Add failing behavior test for task `count: 2` duplicating a task and assigning distinct child indexes.
  - [x] 4.6 GREEN: Implement `count` expansion.
  - [x] 4.7 RED: Add failing behavior test for per-task `reads` and `output` resolving relative to that task cwd, not a chain/artifact dir.
  - [x] 4.8 GREEN: Implement cwd-based path resolution for parallel task IO.
  - [ ] 4.9 REFACTOR: Extract shared child-run/result code used by single and parallel modes.

- [x] 5.0 Add chain execution without chain files
  - [x] 5.1 RED: Add failing integration test for two-step chain where step 2 task uses `{previous}` and receives step 1 output.
  - [x] 5.2 GREEN: Implement minimal sequential chain executor with in-memory previous output.
  - [x] 5.3 RED: Add failing behavior test for `{task}` substitution from top-level task/request in chain step.
  - [x] 5.4 GREEN: Implement `{task}` substitution.
  - [x] 5.5 RED: Add failing behavior test for embedded parallel chain step: all parallel children receive same `{previous}`, and next sequential step receives combined parallel result.
  - [x] 5.6 GREEN: Implement embedded parallel chain steps using existing parallel executor.
  - [x] 5.7 RED: Add failing behavior test asserting chain with `{chain_dir}` fails validation and creates no `progress.md` or exposed chain artifact directory.
  - [x] 5.8 GREEN: Remove chain-dir creation/substitution/progress-file behavior from chain executor.
  - [x] 5.9 RED: Add failing behavior test for chain step `output` resolving against step cwd/top-level cwd.
  - [x] 5.10 GREEN: Implement cwd-based chain output/reads path resolution.
  - [x] 5.11 REFACTOR: Simplify upstream chain code around `ChainRunState` in memory and delete dead worktree/clarify hooks.

- [ ] 6.0 Add async status, interrupt, and resume
  - [x] 6.1 RED: Add failing behavior test: `subagent({agent:"worker", task:"slow", async:true})` returns run id and initial running status without waiting for child completion.
  - [x] 6.2 GREEN: Port/import async job tracker and background launch path.
  - [x] 6.3 RED: Add failing behavior test: `subagent({action:"status", id})` returns running/completed state and latest output for background run.
  - [x] 6.4 GREEN: Implement status inspection over internal run artifacts/session state.
  - [x] 6.5 RED: Add failing behavior test: `subagent({action:"interrupt", id})` sends soft interrupt to active child and reports paused/interrupted state or clear unsupported runtime error.
  - [x] 6.6 GREEN: Implement interrupt path.
  - [x] 6.7 RED: Add failing behavior test: `subagent({action:"resume", id, message:"continue"})` resumes paused child or returns clear unsupported runtime error.
  - [x] 6.8 GREEN: Implement resume path.
  - [x] 6.9 RED: Add failing behavior test for async chain/parallel run status summarizing all child indexes.
  - [x] 6.10 GREEN: Persist enough run metadata for multi-child status.
  - [ ] 6.11 REFACTOR: Keep internal artifacts under session/temp directories and ensure none are exposed as chain files.

- [ ] 7.0 Vendor intercom broker and public `intercom` tool
  - [x] 7.1 RED: Add failing broker unit test for path resolution/spawn smoke behavior copied from upstream expectations.
  - [x] 7.2 GREEN: Copy/vendor broker `broker.ts`, `client.ts`, `framing.ts`, `paths.ts`, and `spawn.ts` with imports adjusted.
  - [x] 7.3 RED: Add failing behavior test asserting extension registers public `intercom` tool with actions `list`, `send`, `ask`, `reply`, `pending`, and `status`.
  - [x] 7.4 GREEN: Extract/register `intercom` tool using vendored client and shared extension state.
  - [x] 7.5 RED: Add failing integration test for two mock sessions: `send` delivers message and receiver sees inline/pending inbound message.
  - [x] 7.6 GREEN: Implement session registration, message send, and inbound message handling.
  - [x] 7.7 RED: Add failing integration test for `ask` blocking until receiver calls `reply`, then returning reply text.
  - [x] 7.8 GREEN: Port `ReplyTracker` and ask/reply flow.
  - [x] 7.9 RED: Add failing behavior test for attachments included in delivered message text.
  - [x] 7.10 GREEN: Implement attachment formatting/support.
  - [ ] 7.11 REFACTOR: Split large upstream `pi-intercom/index.ts` into maintainable helpers without changing public behavior.

- [x] 8.0 Gate and wire child-only `contact_supervisor`
  - [x] 8.1 RED: Add failing behavior test asserting normal sessions do not register `contact_supervisor` when child env vars are absent.
  - [x] 8.2 GREEN: Gate registration on required env vars.
  - [x] 8.3 RED: Add failing behavior test asserting child env vars cause `contact_supervisor` to register with reasons `need_decision`, `progress_update`, and `interview_request`.
  - [x] 8.4 GREEN: Register child-only tool and parse child orchestrator metadata.
  - [x] 8.5 RED: Add failing integration test where child calls `contact_supervisor({reason:"progress_update"})` and parent receives non-blocking intercom update.
  - [x] 8.6 GREEN: Implement non-blocking progress update send.
  - [x] 8.7 RED: Add failing integration test where child calls `contact_supervisor({reason:"need_decision"})`, waits, parent replies, child tool returns reply.
  - [x] 8.8 GREEN: Implement blocking supervisor ask flow.
  - [x] 8.9 RED: Add failing behavior test for `interview_request` validating structured questions and returning structured responses.
  - [x] 8.10 GREEN: Port structured interview validation and reply parsing.
  - [x] 8.11 REFACTOR: Ensure child instruction text recommends `contact_supervisor` for decisions and forbids routine completion handoffs.

- [ ] 9.0 Integrate subagent result/control bridge with intercom
  - [x] 9.1 RED: Add failing integration test proving parent `subagent` run sets supervisor target env so child `contact_supervisor` can reach parent without manual `to`.
  - [x] 9.2 GREEN: Wire parent session identity/intercom target into child process env.
  - [x] 9.3 RED: Add failing behavior test where foreground execution remains alive while child is blocked on `contact_supervisor` and then completes after reply.
  - [x] 9.4 GREEN: Allow intercom/contact-supervisor tool calls in child foreground handling without detaching/falsely completing.
  - [ ] 9.5 RED: Add failing behavior test for async child completion delivered to parent via event/intercom notification when available.
  - [ ] 9.6 GREEN: Port/import result/control bridge pieces compatible with reduced scope.
  - [ ] 9.7 REFACTOR: Deduplicate intercom client lifecycle between public `intercom`, `contact_supervisor`, and result bridge.

- [ ] 10.0 Documentation, skills, and final regression hardening
  - [x] 10.1 RED: Add failing docs test or snapshot asserting `README.md` and skill docs mention single/parallel/chain, async control, intercom, and child-only `contact_supervisor`.
  - [x] 10.2 GREEN: Write README and `skills/pi-subagents/SKILL.md` for reduced API.
  - [x] 10.3 RED: Add failing docs test asserting docs do not mention `/parallel-review`, `/parallel-cleanup`, prompt shortcuts, `chainDir`, `{chain_dir}`, chain files, worktree mode, or agent management actions as supported features.
  - [x] 10.4 GREEN: Remove/adjust docs until unsupported features only appear in explicit “not supported” section if needed.
  - [x] 10.5 RED: Add failing package-wide test that imports extension entrypoint cleanly under Nix/Node transform-types test runner.
  - [x] 10.6 GREEN: Fix module paths, missing dependencies, and TypeScript syntax issues.
  - [x] 10.7 RED: Add failing regression test ensuring registered tool list is exactly expected public tools in normal session: `subagent`, `intercom`.
  - [x] 10.8 GREEN: Remove accidental registrations from copied upstream code.
  - [x] 10.9 REFACTOR: Run full package test suite, delete unused copied files, and update Notes with any intentional deviations from spec.

## Notes

- Recommendation from spec: do not keep `doctor` action. If later wanted, add as separate explicit scope decision.
- Upstream `chain-execution.ts` has deep `chainDir` coupling. Prefer simplifying around in-memory state over deleting lines piecemeal.
- Keep public behavior tests focused on tool calls and package metadata. Avoid tests that lock internal file layout unless package surface requires it.
- On NixOS, run commands directly first. If missing and repo has flake/devShell, use `nix develop -c <command>`. Otherwise use `nix run nixpkgs#<pkg> --command <command>`.
- Recursive removed-field validation now walks all nested params, so removed keys such as `worktree`, `chainDir`, `clarify`, `config`, and `chainName` are rejected inside chain steps and parallel task objects, not only top-level params.
- Async chain start/runner paths were pruned so active async chain code no longer contains old chain-file progress or worktree setup/diff branches. `worktreeSetupHook` config fields remain in shared async config for copied compatibility, but no active async chain path consumes worktree groups.
- Mock Pi integration support now lives under `packages/pi-subagents/test/support`. Integration test `test/integration/subagent-execution.test.ts` covers single child spawn output, top-level parallel child spawn/result ordering via executor, and observable child supervisor env metadata.
- Final blocker cleanup removed undocumented public `agentScope`/`artifacts` schema fields, rejects them explicitly, deleted dead management/chain serializer/doctor source files, and added docs/package surface tests.
- Chain executor rewritten to be in-memory only. It ignores legacy `clarify`, `chainDir`, and worktree hook params for compatibility with caller shape, but does not create shared dirs, progress files, clarify UI, or worktrees. Embedded parallel chain behavior is covered by mock-Pi integration (5.5/5.6).
- Intercom command/shortcut registration removed from vendored module; duplicate `src/intercom-broker-upstream` removed. Active broker remains under `src/intercom-public/broker`.

- Intercom/surface slice added fake Pi registration coverage. Normal sessions register exactly `subagent` and `intercom`; child subagent env registers `contact_supervisor` plus `intercom`. Package files no longer include upstream `CHANGELOG.md`, `*.mjs`, or banner assets.
- Dead removed-feature code cleanup removed shipped slash command sources, chain clarify TUI, worktree module, and shared chain-file helpers. Surface tests now scan shipped source (excluding schema rejection messages) for removed-feature implementation tokens.
- Live intercom integration tests now use isolated HOME and a real broker process. Coverage includes send delivery with attachment display, ask/reply, explicit reply attachment formatting, child `contact_supervisor` progress updates, blocking decisions, and structured interview replies.
- Async interrupt/resume integration tests cover `subagent({ action: "interrupt", id })` against a running pid-backed async status and `subagent({ action: "resume", id, message })` delivering a live-child follow-up through the intercom result bridge.
