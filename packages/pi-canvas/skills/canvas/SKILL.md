---
name: canvas
description: "Use canvas for collaborative visual work surfaces: iterative specs, section feedback, option picking, checkpoint approvals, diagrams, and code or diff display. Includes ready-made layout recipes — copy a recipe, don't design from scratch."
---

# Canvas skill

## When to use

Use canvas when chat-only text is weak for collaboration:

- spec/PRD drafting with iterative section feedback
- option picking and checkpoint approvals
- diagrams (`<mermaid-diagram>`) and code/diff display (`<code-block>`)
- markdown documents the user should read side-by-side (`<markdown-block>`)

## Mental model

Canvas is a temporary sidecar work surface next to chat, not a canonical source of truth. Summarize important feedback into chat/history before final output.

**The canvas owns the design.** Semantic HTML is styled automatically — headings, paragraphs, tables, buttons, inputs, labels all look designed with zero classes. Your job is structure and content, not styling. Start from a recipe below; do not invent layouts or class names.

## Tool reference

- `canvas_render({ selector, html, mode })`
  - selector must target allowed slots; default `mode` is `inner`
  - the result lists currently declared `slots` and may include `warnings` from the design linter — **fix warnings in your next render**
- `canvas_read_signals({ keys? })`
  - read full signal store or selected keys
- `canvas_wait_for_event({ name?, timeoutMs? })`
  - wait for checkpoint/explicit events

## Allowed selectors

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

Guidance: preserve user input containers; patch stable child slots. Do not repeatedly `append` to `#root` — render named slots once, then patch them with `inner`.

## Composition rules

These are rules, not suggestions:

1. `#status` is a one-line strip: current phase or state, under ~100 characters, plain text or a couple of badges. Content never goes here.
2. `#sidebar` holds controls only (inputs, choices, action buttons) — never documents or code.
3. `#root` is one coherent document. Lay it out once with named slots (`data-canvas-slot`), then patch the slot that changed.
4. Prose always goes in `<markdown-block>`; never hand-write `<p>`-heavy HTML or `<table>` markup.
5. Every input control carries `data-signal`; every button carries `data-event`. A control without them is dead UI.
6. Use only the documented helper classes. Unknown classes have no styles and trigger a lint warning.
7. One idea per screen: if a section needs scrolling past ~two viewports, split it into slots or move detail into `<details>`.

## Event model

- Quiet sync: `data-signal` updates only, no transcript steer
- Explicit attention: `data-event="attention:<name>"` posts a concise transcript summary; steers the agent if it is active
- Checkpoint: `data-event="checkpoint:<name>"` resolves a pending `canvas_wait_for_event`; otherwise delivered as a chat message (never both)

Button semantics are also visual: checkpoint buttons render as the filled primary action, attention buttons as accent outlines — pair them accordingly (checkpoint = approve/continue, attention = revise).

## Reactive attributes

Two declarative attributes react to the signal store without any scripting (only a bare signal key, optionally negated with `!` — no expressions):

- `data-show="feedback.global"` — element visible only while the signal is non-empty (`data-show="!feedback.global"` inverts)
- `data-enable-when="feedback.global"` — control disabled until the signal is non-empty

Use them for polish: disable "Send feedback" until text exists, reveal a hint once a choice is made.

## Signal naming

Bind inputs with `data-signal` attributes. Recommended keys:

- `feedback.global`
- `feedback.section.<id>`
- `choice.<id>`
- `review.<id>`

## Styling rules

Semantic HTML is auto-styled; helper classes only add layout intent. This is the complete vocabulary — anything else is unstyled and lint-warned:

| Class | Use |
| --- | --- |
| `card` | raised container for a section of content |
| `callout` | accent-edged aside; combine with `success` / `danger` / `info` |
| `warning` | caution callout |
| `grid` | responsive multi-column of cards |
| `stack` | vertical group with even gaps |
| `row` | horizontal cluster (badges, inline buttons) |
| `toolbar` | right-aligned action strip at a section's end |
| `field` | label + control block |
| `muted` | secondary text |
| `badge` | small status pill; combine with `success` / `danger` / `warning` / `info` |
| `btn-primary` / `btn-quiet` | button emphasis when not using data-event semantics |

Do not inject `<style>` blocks or inline styles — the sanitizer strips them.

## Snippets

Global feedback + checkpoint (the standard control cluster — reuse this shape everywhere):

```html
<section id="canvas-controls" data-canvas-slot="controls">
  <h3>Feedback</h3>
  <label class="field">
    Notes
    <textarea data-signal="feedback.global" placeholder="What should change?"></textarea>
  </label>
  <div class="toolbar">
    <button data-event="attention:revise" data-enable-when="feedback.global">Request changes</button>
    <button data-event="checkpoint:approve" data-payload='{"source":"button"}'>Approve</button>
  </div>
</section>
```

Section feedback:

```html
<section class="card" id="canvas-scope" data-canvas-slot="scope">
  <h3>Scope</h3>
  <markdown-block>**In**: auth flow, token refresh. **Out**: SSO federation.</markdown-block>
  <label class="field">
    Scope notes
    <textarea data-signal="feedback.section.scope"></textarea>
  </label>
  <div class="toolbar">
    <button data-event="attention:revise_scope" data-enable-when="feedback.section.scope">Revise this section</button>
  </div>
</section>
```

## Components

Markdown (always use this for prose):

```html
<markdown-block>## Scope

- **In**: auth flow, token refresh
- **Out**: SSO federation

| Option | Risk |
| --- | --- |
| JWT | medium |
</markdown-block>
```

Markdown source is element text content: escape literal `<` as `&lt;`, and raw HTML inside markdown is sanitized away — use markdown syntax, not embedded HTML.

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
-old behavior
+new behavior
</code-block>
```

## Recipes

Copy the closest recipe and adapt content. Do not design layouts from scratch.

### Recipe: spec review

Status line, one slot per section, controls in the sidebar.

```html
<!-- canvas_render("#status", ...) -->
Spec review — draft 1 of RFC: auth refresh

<!-- canvas_render("#root", ...) -->
<article id="canvas-spec" data-canvas-slot="spec">
  <h1>Auth token refresh</h1>
  <p class="muted">Draft 1 — comment per section in the sidebar, approve when ready.</p>

  <section class="card" id="canvas-goals" data-canvas-slot="goals">
    <h2>Goals <span class="badge">stable</span></h2>
    <markdown-block>...</markdown-block>
  </section>

  <section class="card" id="canvas-design" data-canvas-slot="design">
    <h2>Design <span class="badge warning">draft</span></h2>
    <markdown-block>...</markdown-block>
    <mermaid-diagram>sequenceDiagram
  Client->>API: refresh(token)
  API-->>Client: 200 {token'}
    </mermaid-diagram>
  </section>
</article>

<!-- canvas_render("#sidebar", ...) -->
<section id="canvas-review" data-canvas-slot="review">
  <h3>Review</h3>
  <label class="field">Goals
    <textarea data-signal="feedback.section.goals"></textarea>
  </label>
  <label class="field">Design
    <textarea data-signal="feedback.section.design"></textarea>
  </label>
  <div class="toolbar">
    <button data-event="attention:revise_spec">Request changes</button>
    <button data-event="checkpoint:approve_spec">Approve spec</button>
  </div>
</section>
```

After feedback: patch only the changed slot, e.g. `canvas_render("[data-canvas-slot=\"design\"]", ..., "inner")`, and flip its badge from `warning` to `success`.

### Recipe: option picker

```html
<section id="canvas-options" data-canvas-slot="options">
  <h1>Storage backend</h1>
  <p class="muted">Pick one; add reasoning if it helps.</p>
  <div class="grid">
    <article class="card">
      <h3>SQLite <span class="badge success">recommended</span></h3>
      <markdown-block>Zero-ops, single file. Fine below ~1k writes/s.</markdown-block>
    </article>
    <article class="card">
      <h3>Postgres</h3>
      <markdown-block>Operationally heavier; needed for concurrent writers.</markdown-block>
    </article>
  </div>
  <fieldset>
    <legend>Your pick</legend>
    <label><input type="radio" name="backend" value="sqlite" data-signal="choice.backend" /> SQLite</label>
    <label><input type="radio" name="backend" value="postgres" data-signal="choice.backend" /> Postgres</label>
  </fieldset>
  <label class="field">Reasoning (optional)
    <textarea data-signal="feedback.backend"></textarea>
  </label>
  <div class="toolbar">
    <button data-event="checkpoint:pick_backend" data-enable-when="choice.backend">Confirm choice</button>
  </div>
</section>
```

Then `canvas_wait_for_event({ name: "pick_backend" })` — the resolved event includes a signals snapshot.

### Recipe: diff walkthrough

```html
<section id="canvas-walkthrough" data-canvas-slot="walkthrough">
  <h1>Change walkthrough</h1>
  <section class="card" id="canvas-hunk-1" data-canvas-slot="hunk-1">
    <h3>1 — retry on 401 <span class="badge">src/auth.ts</span></h3>
    <code-block language="diff">@@ -12,3 +12,6 @@
-const res = await fetch(url);
+const res = await fetchWithRetry(url, { on: [401] });
    </code-block>
    <markdown-block>Retries once after refreshing the token; bails on a second 401.</markdown-block>
    <label class="field">Comment
      <textarea data-signal="review.hunk-1"></textarea>
    </label>
  </section>
  <!-- one card slot per hunk -->
  <div class="toolbar">
    <button data-event="attention:address_comments">Address comments</button>
    <button data-event="checkpoint:lgtm">Looks good</button>
  </div>
</section>
```

### Recipe: plan approval

```html
<section id="canvas-plan" data-canvas-slot="plan">
  <h1>Plan: migrate config loader</h1>
  <markdown-block>
1. Extract `loadConfig` behind an interface
2. Add env-file source with tests
3. Cut over call sites, delete legacy parser
  </markdown-block>
  <aside class="callout warning">Step 3 touches 14 call sites — riskiest part.</aside>
  <label class="field">Adjustments
    <textarea data-signal="feedback.plan"></textarea>
  </label>
  <div class="toolbar">
    <button data-event="attention:revise_plan" data-enable-when="feedback.plan">Revise plan</button>
    <button data-event="checkpoint:approve_plan">Approve &amp; start</button>
  </div>
</section>
```

## Anti-patterns

- dumping long markdown in chat while canvas open
- hand-writing HTML prose or tables instead of `<markdown-block>`
- inventing class names or layouts instead of using a recipe
- replacing a parent node that contains active input
- repeatedly appending to `#root` instead of patching named slots
- putting documents or code in `#sidebar`
- posting raw full JSON summaries to transcript
- surprise opening browser without `/canvas`
- treating canvas DOM as persistent state
- ignoring `warnings` returned by `canvas_render`

## Worked example

1. User runs `/canvas`.
2. Agent renders the spec-review recipe: status line, `#root` scaffold with section slots, controls in `#sidebar`.
3. User types section feedback (`feedback.section.design`).
4. User clicks revise button (`attention:revise_spec`).
5. Agent reads summary/signals, revises only the design slot with a targeted `canvas_render`, flips its badge to `success`.
6. User clicks approve (`checkpoint:approve_spec`); the pending `canvas_wait_for_event` resolves.
7. User asks for the final file; agent writes it from the summarized canvas feedback.
