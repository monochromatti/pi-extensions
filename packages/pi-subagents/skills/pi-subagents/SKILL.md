---
name: pi-subagents
description: Delegate work to minimal subagents and coordinate with local Pi sessions.
---

# pi-subagents

Use `subagent` when task benefits from isolated execution, parallel review/research, or staged chain handoff.

## Single

```js
subagent({ agent: "worker", task: "Make focused edit and run tests" })
```

## Parallel

```js
subagent({
  tasks: [
    { agent: "researcher", task: "Find relevant code paths" },
    { agent: "reviewer", task: "Review proposed approach" }
  ],
  concurrency: 2
})
```

## Chain

Chain steps pass text with `{previous}`. Top-level task can be inserted with `{task}`.

```js
subagent({
  task: "Build feature",
  chain: [
    { agent: "researcher", task: "Scout files for {task}" },
    { agent: "planner", task: "Create plan from:\n{previous}" },
    { agent: "worker", task: "Implement:\n{previous}" }
  ]
})
```

## Async control

```js
subagent({ agent: "worker", task: "Long task", async: true })
subagent({ action: "status", id: "run-id" })
subagent({ action: "interrupt", id: "run-id" })
subagent({ action: "resume", id: "run-id", message: "Continue" })
```

## Intercom

```js
intercom({ action: "list" })
intercom({ action: "send", to: "session", message: "Update" })
intercom({ action: "ask", to: "session", message: "Decision needed" })
intercom({ action: "reply", message: "Approved" })
```

## Child supervisor contact

Delegated children may use `contact_supervisor` when blocked or when a product/API/scope decision is required. `need_decision` waits for reply. `progress_update` sends non-blocking update. `interview_request` requests structured answers.

Do not use `contact_supervisor` for routine completion; final result should return normally.

## Boundaries

Unsupported by design: prompt shortcuts, chain files/shared chain directories, agent management actions, clarify TUI, and worktree mode.

Agent frontmatter and `subagents.agents.<name>.mutationGuard` may set `auto | never | explicit | always` to control no-edit completion failures. Use `never` for review/planning/research-only agents, `explicit` for reviewers that edit only when directly instructed, `auto` for writers, `always` for agents that must mutate files every successful run unless explicit no-edit/review-only instructions apply.
