# Implementation plan for extension-runner-harness

Replace the custom fake Pi extension harness in `intercom-live.test.ts` with a harness built on upstream `@earendil-works/pi-coding-agent` extension runtime primitives. The goal is not full end-to-end Pi execution. The goal is better mocked session tests: real extension loading, real lifecycle dispatch, real context creation, and real registered-tool lookup through `ExtensionRunner`, while keeping broker/model/session behavior deterministic and mocked.

## Relevant files

- `packages/pi-subagents/spec-extension-runner-harness.md` - Source spec describing scope, requirements, and helper skeleton.
- `packages/pi-subagents/test/integration/intercom-live.test.ts` - Main integration test file whose custom `createHarness()` should be replaced or refactored to use upstream `ExtensionRunner`.
- `packages/pi-subagents/test/support/pi-runner-harness.ts` - Optional new helper file if extracted harness is cleaner than keeping helper inline.
- `packages/pi-subagents/package.json` - Test script may be updated separately if deciding to include colocated `src/**/*.test.ts`; not required for this harness refactor.
- `packages/pi-subagents/src/extension/index.ts` - Extension entrypoint loaded by `discoverAndLoadExtensions`; production source should not need changes.

## Instructions for completing tasks

Before starting work, check the current state of tasks (find out what has already been completed), and read the Notes section.

**IMPORTANT:** As you complete each task, you must check it off in this markdown file by changing `- [ ]` to `- [x]`. This helps track progress and ensures you don't skip any steps.

Example:
- `- [ ] 1.1 Read file` → `- [x] 1.1 Read file` (after completing)

Update the file after completing each sub-task, not just after completing an entire parent task.

If applicable, update the Notes section with lessons, discoveries and design choices that may be of interest to the engineer that takes on the next parent task, assuming they are not aware of any of the thought processes so far and only see the result of the finalized tasks prior.

## Tasks

- [x] 1.0 Establish baseline and locate harness seams
  - [x] 1.1 RED: Add or identify a focused assertion in `intercom-live.test.ts` that expresses the desired public behavior: a normal started session exposes the `intercom` tool through the test harness.
  - [x] 1.2 GREEN: Run existing `npm test` from `packages/pi-subagents` and confirm current custom harness passes before refactor.
  - [x] 1.3 REFACTOR: Read `createHarness()` call sites and note exact external API currently used (`start`, `shutdown`, `tool`, `ctx`, `sentMessages`, `entries`, `idle` option) so replacement can preserve behavior.

- [x] 2.0 Introduce upstream-runner harness for normal session registration
  - [x] 2.1 RED: Change the normal-session registration assertion to require `runner.getToolDefinition("intercom")`, making current custom harness insufficient.
  - [x] 2.2 GREEN: Replace `createHarness()` internals with upstream `discoverAndLoadExtensions`, `createEventBus`, and `ExtensionRunner`; bind minimal mocked core/context actions; expose `runner` on returned harness.
  - [x] 2.3 GREEN: Keep existing external harness API compatible enough that at least the normal-session registration assertion and existing `intercom status` startup path pass.
  - [x] 2.4 REFACTOR: Remove direct `registerSubagentExtension` import and manual lifecycle handler storage if no longer needed.

- [x] 3.0 Preserve intercom send/ask behavior through runner-created context
  - [x] 3.1 RED: Run the first existing broker behavior test (`intercom send delivers message and records pending inbound ask`) against the runner harness; capture failing context/runtime gaps.
  - [x] 3.2 GREEN: Fill only missing mocked runtime/context actions needed for send delivery (`sendMessage`, `appendEntry`, `getSessionName`, `isIdle`, `getSignal`, etc.).
  - [x] 3.3 RED: Run ask/reply tests (`ask waits for reply tool response`, `ask reply includes attachment formatting`) against the runner harness.
  - [x] 3.4 GREEN: Preserve `sentMessages`, `entries`, and session identity behavior so ask/reply assertions pass without weakening assertions.
  - [x] 3.5 REFACTOR: Keep harness types narrow and local; prefer public upstream imports from `@earendil-works/pi-coding-agent` over deep `dist/` imports.

- [x] 4.0 Preserve child-session `contact_supervisor` behavior through upstream lifecycle
  - [x] 4.1 RED: Add or update assertion that a child-env started session exposes `contact_supervisor` via `runner.getToolDefinition("contact_supervisor")`.
  - [x] 4.2 GREEN: Ensure `withChildEnv()` plus runner-driven `session_start` registers child-only supervisor tool through actual extension lifecycle.
  - [x] 4.3 RED: Run `contact_supervisor progress_update` test against runner harness and observe any behavior gap.
  - [x] 4.4 GREEN: Fill minimal mocked actions/options needed for non-blocking supervisor progress delivery.
  - [x] 4.5 RED: Run `contact_supervisor need_decision` and `interview_request` tests against runner harness.
  - [x] 4.6 GREEN: Preserve blocking reply/interview behavior with real broker process and runner-created contexts.
  - [x] 4.7 REFACTOR: Remove obsolete fake lifecycle code and ensure env cleanup still uses existing `withChildEnv()`/process exit cleanup patterns.

- [x] 5.0 Validate full suite and document harness behavior
  - [x] 5.1 RED: Run full `npm test` in `packages/pi-subagents`; record any failures caused by harness refactor.
  - [x] 5.2 GREEN: Fix failures with minimal test harness changes, not production behavior changes, unless production bug is revealed.
  - [x] 5.3 REFACTOR: If `createHarness()` is large or useful elsewhere, extract to `test/support/pi-runner-harness.ts`; otherwise keep inline to avoid premature abstraction.
  - [x] 5.4 GREEN: Re-run `npm test` and confirm all tests pass.
  - [x] 5.5 REFACTOR: Update comments in `intercom-live.test.ts` or helper to explain why tests use upstream `ExtensionRunner` but still mock model/session/CLI behavior.

## Notes

- Keep mock scope intentional: real upstream extension loader/runner and real broker process; mocked model, UI, session manager, and child CLI.
- Do not broaden to real `pi` binary execution.
- `ExtensionRunner` constructor needs `sessionManager` and `modelRegistry`; minimal objects cast to `never` are acceptable if public runner APIs do not require full implementations.
- Prefer preserving current test assertions. Only strengthen assertions where they verify runner-backed behavior.
- Current package `npm test` runs `test/**/*.test.ts`; colocated `src/**/*.test.ts` are outside this plan unless explicitly chosen later.
