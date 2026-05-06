# pi-subagents

Minimal Pi extension for delegating work to subagents and messaging other Pi sessions.

## Tools

- `subagent` — run single, parallel, or chained subagent tasks; supports async status/interrupt/resume.
- `intercom` — list/send/ask/reply/pending/status messages between local Pi sessions.
- `contact_supervisor` — available only inside delegated child sessions with supervisor metadata.

## Examples

Single:

```js
subagent({ agent: "worker", task: "Implement the requested fix" })
```

Parallel:

```js
subagent({
  tasks: [
    { agent: "researcher", task: "Inspect API usage" },
    { agent: "reviewer", task: "Review current patch" }
  ],
  concurrency: 2
})
```

Chain:

```js
subagent({
  chain: [
    { agent: "researcher", task: "Find relevant files for {task}" },
    { agent: "planner", task: "Plan from findings:\n{previous}" },
    { agent: "worker", task: "Implement plan:\n{previous}" }
  ],
  task: "Add feature X"
})
```

Async control:

```js
subagent({ agent: "worker", task: "Long task", async: true })
subagent({ action: "status", id: "run-id" })
subagent({ action: "interrupt", id: "run-id" })
subagent({ action: "resume", id: "run-id", message: "Continue with option B" })
```

Intercom:

```js
intercom({ action: "list" })
intercom({ action: "send", to: "session-name", message: "FYI" })
intercom({ action: "ask", to: "session-name", message: "Need decision" })
intercom({ action: "reply", message: "Approved" })
```

## Not supported

This package intentionally omits prompt shortcuts, chain files, shared chain directories, agent management actions, clarify TUI, and worktree mode.
