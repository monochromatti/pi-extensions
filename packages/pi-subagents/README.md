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

## Settings JSON model configuration

Use `~/.pi/agent/settings.json` (user) or `.pi/settings.json` (project).

```json
{
  "subagents": {
    "agents": {
      "worker": {
        "model": "openai-codex/gpt-5.5-codex",
        "thinking": "high",
        "fallbackModels": ["anthropic/claude-sonnet-4-5"]
      },
      "researcher": {
        "thinking": "medium",
        "mutationGuard": "never"
      }
    },
    "agentOverrides": {
      "oracle": {
        "model": "openai-codex/gpt-5.5-codex",
        "thinking": "high"
      }
    }
  }
}
```

Notes:
- `subagents.agents` applies model/thinking/fallback/mutationGuard config to any discovered agent name.
- `subagents.agentOverrides` remains builtin-agent override path.
- Project settings override user settings.
- Agent frontmatter and settings support `mutationGuard: auto | never | explicit | always`. Builtins use `auto` for writer agents, `explicit` for reviewer, and `never` for oracle/planner/researcher. `always` still respects explicit no-edit/review-only instructions.

## Runtime model/thinking overrides

Supervisor can override at invocation time:

```js
subagent({ agent: "worker", task: "Implement fix", model: "anthropic/claude-sonnet-4-5", thinking: "low" })
```

Also supported on parallel tasks and chain steps (`tasks[i].thinking`, `chain[i].thinking`, `chain[i].parallel[j].thinking`).

## Not supported

This package intentionally omits prompt shortcuts, chain files, shared chain directories, agent management actions, clarify TUI, and worktree mode.
