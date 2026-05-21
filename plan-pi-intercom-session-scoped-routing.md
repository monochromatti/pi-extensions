# Implementation plan for pi-intercom session-scoped routing

Goal: eliminate pi-intercom leakage where subagent/supervisor messages appear in unrelated Pi sessions. Implement target architecture from `spec-pi-intercom-session-scoped-routing.md`: per-Pi-session intercom runtimes, ID-based broker routing, owner-scoped subagent relay events, and behavior tests through public tool/broker surfaces.

Core idea: make `IntercomRuntime` the deep module/facade. Callers ask for intent-level behavior (`intercom`, `contact_supervisor`, supervisor target creation). Runtime/broker own lifecycle, routing, validation, and diagnostics. Avoid spreading fallback rules across child tools, parent executor paths, and tests.

## Relevant files

- `spec-pi-intercom-session-scoped-routing.md` - Source specification for this plan.
- `packages/pi-subagents/src/intercom-public/index.ts` - Main pi-intercom extension entrypoint; currently contains process-global runtime state and tool handlers.
- `packages/pi-subagents/src/intercom-public/types.ts` - Shared broker/session/message types; add `piSessionId`, protocol/capability, target envelope, and receiver metadata shapes.
- `packages/pi-subagents/src/intercom-public/broker/broker.ts` - Broker registration and target resolution; add protocol v2 registration, structured target envelope routing, duplicate-name behavior, namespace-constrained name lookup.
- `packages/pi-subagents/src/intercom-public/broker/client.ts` - Client registration/send/list API; add protocol v2 fields, structured target send support, receiver metadata handling.
- `packages/pi-subagents/src/intercom/intercom-bridge.ts` - Parent bridge state/instruction target construction; move from string target toward supervisor descriptor.
- `packages/pi-subagents/src/runs/foreground/subagent-executor.ts` - Foreground subagent launch paths; ensure parent intercom runtime connects and passes supervisor descriptor.
- `packages/pi-subagents/src/runs/background/subagent-runner.ts` - Background/async subagent run metadata and relay payloads; include owner Pi session ID and structured target.
- `packages/pi-subagents/src/runs/shared/child-run-preparation.ts` - Child env creation; add supervisor ID env vars.
- `packages/pi-subagents/src/runs/shared/pi-args.ts` - Pi child process env propagation; add supervisor target env vars.
- `packages/pi-subagents/src/runs/shared/subagent-prompt-runtime.ts` - Child-side runtime setup; preserve child intercom session naming and expose supervisor env to `contact_supervisor`.
- `packages/pi-subagents/test/integration/intercom-live.test.ts` - Existing public behavior integration tests for broker/tool flows; extend for multi-session leakage and supervisor routing.
- `packages/pi-subagents/test/integration/subagent-execution.test.ts` - Existing subagent execution tests; extend for bridge registration failure and owner-scoped relay metadata.
- `packages/pi-subagents/test/unit/broker.test.ts` - Broker target resolution unit/behavior tests; extend for exact ID, Pi session ID fallback, duplicate names, namespace behavior.
- `packages/pi-subagents/test/unit/registration-surface.test.ts` - Tool registration/schema tests; update if `intercom`/`contact_supervisor` parameter schemas change.

## Instructions for completing tasks

Before starting work, check current task status and read Notes.

**IMPORTANT:** As each task completes, check it off in this file by changing `- [ ]` to `- [x]`. Update after each sub-task, not only after parent tasks.

Run focused tests after each GREEN step. Preferred command from repo root:

```bash
npm --workspace packages/pi-subagents test -- --test-name-pattern '<pattern>'
```

If test runner pattern support differs, run full package test:

```bash
npm --workspace packages/pi-subagents test
```

If command missing on NixOS, follow repo convention: direct command first, then `nix develop -c <command>` if flake/devShell exists, then `nix run nixpkgs#<pkg>`.

## Tasks

- [x] 1.0 Make broker/client protocol support ID-based routing
  - [x] 1.1 RED: Add broker/client behavior test proving two sessions with the same `name` can still be reached unambiguously by exact broker `intercomSessionId`.
  - [x] 1.2 GREEN: Extend `SessionInfo` registration/types with `piSessionId`, `protocolVersion`, and `capabilities`; make broker exact broker-ID lookup pass without relying on name.
  - [x] 1.3 RED: Add behavior test proving structured target envelope falls back from missing/stale `intercomSessionId` to live `piSessionId`.
  - [x] 1.4 GREEN: Add structured target envelope support in `IntercomClient.send` and broker resolution order: `intercomSessionId` -> `piSessionId` -> alias/name.
  - [x] 1.5 RED: Add behavior test proving duplicate manual names return deterministic error with candidate details instead of choosing arbitrary session.
  - [x] 1.6 GREEN: Implement duplicate-name error behavior for plain string/manual targets.
  - [x] 1.7 RED: Add behavior test proving namespace constrains alias/name lookup but exact IDs ignore namespace.
  - [x] 1.8 GREEN: Implement optional namespace handling for name lookup only.
  - [x] 1.9 RED: Add manual-compat canary proving normal `intercom list` and manual name send still work for unique names with protocol v2 registration.
  - [x] 1.10 GREEN: Preserve manual list/name-send behavior while keeping duplicate-name deterministic errors.
  - [x] 1.11 REFACTOR: Keep broker target resolution policy localized in one function/module; remove fallback-order duplication from client/call sites.

- [x] 2.0 Introduce session-scoped `IntercomRuntime` facade
  - [x] 2.1 RED: Add integration test with two Pi sessions in one process: message addressed to session A is recorded by session A inbox/event stream and absent from session B, even after session B starts later. Avoid brittle TUI text snapshots.
  - [x] 2.2 GREEN: Introduce `Map<piSessionId, IntercomRuntime>` and create/remove runtimes on session lifecycle, with minimal behavior still passing existing tests.
  - [x] 2.3 RED: Add behavior test proving tool execution in session A uses session A runtime even if session B is current/latest.
  - [x] 2.4 GREEN: Update `intercom` and `contact_supervisor` tool handlers to select runtime strictly from execution `ctx.sessionManager.getSessionId()`.
  - [x] 2.5 RED: Add behavior test proving inbound broker callbacks are delivered through the owning runtime instance, not a latest/global runtime.
  - [x] 2.6 GREEN: Bind broker/client inbound handlers to their owning `IntercomRuntime` and remove inbound delivery dependence on module-global current context.
  - [x] 2.7 REFACTOR: Add injected scheduler seam for runtime timers/reconnect/inbound flush so replacement/shutdown race tests can be deterministic without global fake timers.
  - [x] 2.8 RED: Add deterministic behavior test where old runtime async delivery fires after replacement/shutdown and must not display message.
  - [x] 2.9 GREEN: Add runtime generation/cancel token checks and unregister listeners before async shutdown awaits.
  - [x] 2.10 REFACTOR: Split runtime internals behind local/private seams (`RuntimeTransport`, `RuntimeInbox`, `RuntimeRouter`) while preserving one facade for callers.

- [x] 3.0 Add receiver metadata and misroute diagnostics
  - [x] 3.1 RED: Add broker/client behavior test proving machine-originated message includes `message.to.piSessionId` for resolved target.
  - [x] 3.2 GREEN: Populate receiver metadata for structured target sends and preserve manual sends without requiring metadata.
  - [x] 3.3 RED: Add runtime behavior test proving inbound machine message with mismatched `message.to.piSessionId` is dropped and not displayed.
  - [x] 3.4 GREEN: Implement receiver sanity guard in `IntercomRuntime` before queue/UI delivery.
  - [x] 3.5 RED: Add test proving dropped misroute records structured diagnostic fields (`messageId`, sender id/name, intended Pi session, actual Pi session, timestamp, reason) without unbounded growth.
  - [x] 3.6 GREEN: Add bounded diagnostics storage or `appendEntry` stream for dropped misroutes.
  - [x] 3.7 REFACTOR: Keep diagnostics low-noise and local to runtime/router; do not expose new caller obligations.

- [x] 4.0 Route subagent supervisor traffic through structured supervisor targets
  - [x] 4.1 RED: Add subagent execution behavior test proving parent launch fails when intercom bridge is active but parent runtime cannot register/connect.
  - [x] 4.2 GREEN: Add parent-side `getSupervisorTarget()`/equivalent facade method that ensures intercom registration and fails launch on unsafe routing.
  - [x] 4.3 RED: Add behavior test proving `getSupervisorTarget()` rejects if connected client/session lacks protocol v2 or `piSessionId-routing` capability.
  - [x] 4.4 GREEN: Add protocol/capability checks to supervisor target creation; keep manual intercom soft-degrade outside bridge path.
  - [x] 4.5 RED: Add test proving child env includes `PI_SUBAGENT_SUPERVISOR_INTERCOM_SESSION_ID`, `PI_SUBAGENT_SUPERVISOR_PI_SESSION_ID`, `PI_SUBAGENT_SUPERVISOR_ALIAS`, and `PI_SUBAGENT_SUPERVISOR_CWD`.
  - [x] 4.6 GREEN: Thread `SupervisorIntercomTarget` through foreground/background child prep (`subagent-executor`, `subagent-runner`, `child-run-preparation`, `pi-args`).
  - [x] 4.7 RED: Add integration test proving `contact_supervisor` from child sends one structured target envelope and reaches delegating session by `intercomSessionId`, not parent display name.
  - [x] 4.8 GREEN: Update child-side `contact_supervisor` to read supervisor descriptor and call broker/client with structured target envelope.
  - [x] 4.9 RED: Add behavior test proving if broker ID is stale but parent reconnected under same `piSessionId`, broker fallback still delivers supervisor message to parent.
  - [x] 4.10 GREEN: Rely on broker target fallback; remove child-side identity retry/fallback loops.
  - [x] 4.11 REFACTOR: Keep supervisor target construction in one bridge/runtime seam; remove string-only `orchestratorTarget` assumptions where used for routing.

- [x] 5.0 Scope subagent relay events by owning Pi session
  - [x] 5.1 RED: Add behavior test with runtimes A and B proving relay consumer ignores `SUBAGENT_RESULT_INTERCOM_EVENT` when `ownerPiSessionId` does not match runtime B.
  - [x] 5.2 GREEN: Add consumer-side `ownerPiSessionId` requirement and filter result relay handling by owning runtime; do not update all producers yet.
  - [x] 5.3 RED: Add behavior test proving relay consumer ignores `SUBAGENT_CONTROL_INTERCOM_EVENT` for owner A in runtime B even if B is latest/idle.
  - [x] 5.4 GREEN: Apply same consumer-side owner filter to control/needs-attention relay handling.
  - [x] 5.5 RED: Add foreground/control producer test proving emitted control relay payload includes `ownerPiSessionId` and structured `target`.
  - [x] 5.6 GREEN: Update foreground/control payload construction.
  - [x] 5.7 RED: Add async result watcher/tracker producer test proving grouped result intercom payload includes `ownerPiSessionId` and structured `target`.
  - [x] 5.8 GREEN: Update background result watcher/tracker payload construction and acknowledgement paths.
  - [x] 5.9 REFACTOR: Remove any relay code path that references global/latest runtime rather than owner runtime.

- [x] 6.0 Preserve manual intercom behavior and finish hardening
  - [x] 6.1 RED: Add regression test for manual `intercom ask/reply/pending` between two normal sessions with protocol v2 registration.
  - [x] 6.2 GREEN: Fix any manual action regressions from structured routing changes.
  - [x] 6.3 RED: Add registration/list/status behavior test proving protocol v2 fields do not clutter user-facing session labels but are available in details.
  - [x] 6.4 GREEN: Adjust list/status formatting if needed.
  - [x] 6.5 RED: Add regression test proving protocol/capability absence soft-degrades for manual use while bridge failure message remains clear.
  - [x] 6.6 GREEN: Polish safe failure messages/manual soft-degrade behavior without moving bridge safety checks out of `getSupervisorTarget()`.
  - [x] 6.7 REFACTOR: Review for good-code shape: small public runtime facade, localized broker routing policy, no duplicated fallback order, no module-global current runtime.
  - [x] 6.8 VERIFY: Run full `npm --workspace packages/pi-subagents test` and update this plan Notes with any important findings.

## Notes

- Use behavior tests through public surfaces where possible: broker client API, registered tools, subagent executor behavior. Avoid tests that lock down private helper choreography.
- For async race behavior, use an injected scheduler seam rather than global fake timers. This keeps tests deterministic and production timing policy localized.
- For multi-session leak tests, prefer assertions on message receipt/inbox/event records and absence in other runtime over brittle TUI text snapshots.
- `IntercomRuntime` should be deep from caller perspective but internally organized enough to avoid a god object.
- Fallback order belongs in broker target resolution. Child/parent code should pass a structured target envelope and not replicate routing policy.
- Machine-originated subagent/supervisor messages should carry receiver metadata; manual human sends may omit it.
- This work is correctness/isolation, not local-process security. Env metadata can be forged by local processes; do not add token auth unless threat model changes.
- Task 4 introduced `PI_SUBAGENT_SUPERVISOR_*` env metadata plus a host-bound supervisor-target resolver seam (`intercom-public/supervisor-target-resolver.ts`) so executor paths fail fast when safe routing metadata cannot be produced.
- Task 6 preserved manual UX while exposing protocol metadata in `details`: list/status text stays uncluttered, and `details` now includes protocol/capability/piSessionId fields for diagnostics.
- Manual intercom soft-degrades with legacy peers (no protocol v2 capability) for list/send flows, while bridge-active subagent launch still fails with clear unsafe-routing reason text.
- 6.8 verify run completed: `npm --workspace packages/pi-subagents test` passed (127/127).
