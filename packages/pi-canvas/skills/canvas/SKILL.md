---
name: canvas
description: "Use canvas for collaborative visual work surfaces: iterative specs, section feedback, option picking, checkpoint approvals, diagrams, and code or diff display."
---

# Canvas skill

## When to use

Use canvas when chat-only text weak for collaboration:

- spec/PRD drafting with iterative section feedback
- option picking and checkpoint approvals
- diagrams (`<mermaid-diagram>`) and code/diff display (`<code-block>`)

## Mental model

Canvas is temporary sidecar work surface next to chat.
Not canonical source of truth. Summarize important feedback into chat/history before final output.

## Tool reference

- `render({ selector, html, mode })`
  - selector must target allowed slots
  - default `mode` is `inner`
- `read_signals({ keys? })`
  - read full signal store or selected keys
- `wait_for_event({ name?, timeoutMs? })`
  - wait for checkpoint/explicit events

## Allowed selectors

Allowed selectors:

- built-ins: `#root`, `#status`, `#sidebar`
- ids with `#canvas-...`
- `[data-canvas-slot]`
- declared slot form: `[data-canvas-slot="name"]`

Avoid arbitrary selectors like `div` or random `#notes`.

## Render modes

- `inner`: replace element contents
- `outer`: replace element itself
- `append`: append content
- `prepend`: prepend content

Guidance: preserve user input containers; patch stable child slots.

## Event model

- Quiet sync: signal updates only, no transcript steer
- Explicit attention: concise transcript summary; steer if agent active
- Checkpoint: resolves `wait_for_event`; no duplicate steer by default

## Signal naming

Recommended keys:

- `feedback.global`
- `feedback.section.<id>`
- `choice.<id>`
- `review.<id>`

## Snippets

Global feedback + checkpoint:

```html
<section data-canvas-slot="review-panel">
  <h3>Feedback</h3>
  <textarea data-bind="feedback.global" placeholder="What should change?"></textarea>
  <button data-event="attention:revise_scope">Send feedback</button>
  <button data-event="checkpoint:approve_scope" data-payload='{"source":"button"}'>Approve</button>
</section>
```

Section feedback:

```html
<section id="canvas-scope" data-canvas-slot="scope">
  <h4>Scope</h4>
  <textarea data-bind="feedback.section.scope"></textarea>
  <button data-event="attention:revise_scope">Revise this section</button>
</section>
```

## Components

Mermaid:

```html
<mermaid-diagram>
graph TD
  A[Draft] --> B[Review]
  B --> C[Revise]
</mermaid-diagram>
```

Code block:

```html
<code-block language="ts">const ok = true;</code-block>
```

Diff block:

```html
<code-block language="diff">@@ -1,2 +1,2 @@
-old line
+new line
</code-block>
```

## Styling rules

Use semantic HTML + Pico baseline + helper classes (`callout`, `warning`, `grid`, `muted`, `badge`).
Do not inject `<style>` blocks or inline styles.

## Anti-patterns

- dumping long markdown in chat while canvas open
- replacing parent node that contains active input
- posting raw full JSON summaries to transcript
- surprise opening browser without `/canvas`
- treating canvas DOM as persistent state

## Worked example

1. User runs `/canvas`.
2. Agent `render`s scaffold into `#root` with section slots.
3. User types section feedback (`feedback.section.scope`).
4. User clicks revise button (`attention:revise_scope`).
5. Agent reads summary/signals, revises only scope slot with targeted `render`.
6. User clicks approve (`checkpoint:approve_scope`), agent `wait_for_event` resolves.
7. User asks final output file; agent writes final artifact using summarized feedback.
