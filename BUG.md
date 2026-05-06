# Bug: chain subagents fail with Anthropic when parent context contains thinking blocks

## Symptom

Calling `subagent({ chain: [...] })` against an Anthropic model fails on
the very first child step. The chain reports `Children: 1 failed` and no
work happens. Subsequent steps never start.

The child session log shows the failure as an HTTP 400 from Anthropic on
the first model call:

```
400 {"type":"error","error":{"type":"invalid_request_error","message":
"messages.11.content.1: `thinking` or `redacted_thinking` blocks in the
latest assistant message cannot be modified. These blocks must remain
as they were in the original response."},"request_id":"..."}
```

Stop reason on the assistant message is `error`, with `usage` all zero
— the request never made it past Anthropic's validation.

## Root cause

The default execution mode for `worker` (and several other builtin
agents) is `context: fork`. A forked child is spawned by *cloning the
parent session* and appending a new task message before resuming.

When the parent session contains a recent assistant message with
extended-thinking content blocks (Anthropic streams these as
`thinking` / `redacted_thinking` blocks), those blocks are part of the
cloned message history. The pi-subagents fork machinery then mutates
the cloned history — at minimum it appends a new `user` task message,
and depending on the agent it may also rewrite or splice prior turns to
inject the task scaffolding.

Anthropic's API rejects any request whose conversation history contains
`thinking` / `redacted_thinking` blocks that are not byte-identical to
the originals it produced. Since the fork machinery touches messages
near (or after) those blocks, validation fails and the worker child
never gets to run its first turn.

Practically: any time the parent session has been "thinking" recently,
forking it into an Anthropic-backed worker poisons the first request.

## Why this didn't surface before

- Models without extended-thinking blocks (or older Anthropic accounts
  with thinking disabled) don't hit the rule. The same chain shape
  works fine.
- Forking from a *fresh* parent session before any thinking-laden turn
  also works.
- Single-step `subagent({ agent, task })` calls with `context: fresh`
  obviously don't fork, so they bypass it entirely.
- The failure presents as a generic 400 inside the child, which is
  easy to misread as a bad task prompt rather than a forking problem.

## Workaround

Pass `context: "fresh"` explicitly at the top level of the
`subagent(...)` call:

```js
subagent({
  context: "fresh",
  chain: [ ... ],
})
```

A fresh child gets a clean conversation; it reads any required context
from disk via `reads:` or in the task prompt itself. The chain then
runs end-to-end against Anthropic without tripping the thinking-block
rule.

In this codebase that meant pointing each worker at the spec and plan
files (`specs/spec-job-logging-reshape.md`,
`specs/plan-job-logging-reshape.md`) and letting them re-read the
relevant state at the start of their step. Cost: a few extra file
reads per child; benefit: the chain actually runs.

## Suggested fix in pi-subagents

Three reasonable directions, in order of preference:

1. **Strip `thinking` / `redacted_thinking` blocks from the cloned
   history before mutation.** Preserves the fork — the child still
   inherits full user/assistant text, tool calls, tool results, and
   prior decisions — but drops the parent's internal chain-of-thought.
   Anthropic's preservation rule only fires when thinking blocks are
   *present and modified*; absent blocks raise no error. This is the
   cleanest fix because it keeps `context: fork` doing what its name
   says (continue the conversation in a child) at the cost of one
   feature (visibility into parent's reasoning), which the child
   rarely needs for a handoff anyway.

   Implementation sketch: walk the cloned message list, for each
   assistant message filter `content` to drop blocks whose `type` is
   `thinking` or `redacted_thinking`. Do this before any task message
   is appended.

2. **Detect Anthropic + thinking blocks and downgrade to fresh.** If
   stripping is too invasive, fall back: when the target child model
   is Anthropic and the parent's tail contains thinking blocks,
   automatically downgrade `context: fork` to `context: fresh` and
   emit a one-line warning. Less useful than (1) — child loses all
   inherited context, not just the chain-of-thought — but trivial to
   implement.

3. **Change defaults.** Make `context: fresh` the default for chain
   children unless an agent explicitly opts into fork. Useful
   regardless of (1) or (2): the spec/plan-on-disk pattern is the
   right shape for most implementation handoffs, and a fresh child
   forces the caller to be explicit about what state matters.

(1) is the right fix. (2) is a safe-mode fallback. (3) is a
defaults-hygiene change orthogonal to the bug. Until any of them
ships: always set `context: "fresh"` for any chain that hands off to
Anthropic-backed workers from a session that has been thinking.

## Reproduction

1. Open a pi session against an Anthropic model with extended thinking
   enabled.
2. Have any non-trivial conversation (a few thinking-emitting turns is
   enough).
3. Call:
   ```js
   subagent({ chain: [{ agent: "worker", task: "anything" }] })
   ```
4. Observe the chain fail with the 400 above on step 1, before any
   tool runs.

Adding `context: "fresh"` to the same call makes it succeed.
