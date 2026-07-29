---
name: canvas
description: "Use canvas for collaborative visual work surfaces: compact specs, option picking, checkpoint approvals, diagrams, and code or diff display. Users comment on any text by selecting it. Includes ready-made layout recipes — copy a recipe, don't design from scratch."
---

# Canvas skill

## When to use

Use canvas when chat text is a weak medium for the work:

- comparing options (table beats three paragraphs)
- showing structure or flow (`<mermaid-diagram>`)
- reviewing concrete change (`<code-block language="diff">`)
- a document the user reads while you keep working (`<markdown-block>`)
- decisions that need an explicit answer or approval

Do not use canvas to restate a chat answer in bigger letters.

## Mental model

Canvas is a temporary sidecar work surface, not a source of truth. Summarize important feedback into chat before final output.

Three rules define good canvas work:

1. **Compress.** Canvas earns its place by cutting reading time. If your render is mostly paragraphs, you have written a chat message in a browser tab.
2. **The canvas owns the design.** Semantic HTML is auto-styled — headings, tables, buttons, inputs. Your job is structure and content. Start from a recipe; do not invent layouts or class names.
3. **The user can already comment.** Selecting any rendered text opens a comment box; the quote plus their note reaches you as an attention event. So never render generic "any thoughts?" boxes — controls exist only for decisions you cannot make alone.

Visual language is fixed: black-and-white shadcn-like surfaces, restrained borders. Color means success, warning, danger, info — never decoration.

## Compression playbook

Pick the densest format the content allows:

| You want to say | Use | Not |
| --- | --- | --- |
| A vs B vs C | markdown table, one row per option, columns = criteria | prose per option |
| How it flows / who calls what | `<mermaid-diagram>` | numbered narration |
| What exactly changes | `<code-block language="diff">` | description of the change |
| State of N things | table + `.badge` (`stable`, `draft`, `blocked`) | status paragraphs |
| Steps | ordered list, ≤10 words per step | paragraph per step |
| Caveat | one `.callout warning`, one sentence | a "Risks" section |
| Supporting detail | `<details>` | inline expansion |

Budgets, enforced by the linter:

- a paragraph over ~450 characters is a paragraph you have not finished editing
- a render over ~1200 characters with no table, list, diagram, or code is a wall of text
- a render over ~5000 characters is more than a reader scans — split into slots or `<details>`
- prefer captions and labels over sentences; delete every sentence that restates a table

## Selection comments (built in)

Users select any text in `#root` or `#sidebar` and write a comment. You receive:

```
Canvas comment [design] on "Refresh happens on the first 401.": Second 401 should bail.
```

The full list is also in signals under `comments` (`canvas_read_signals({ keys: ["comments"] })`), each entry `{ index, slot, quote, note, at }`. The key is server-owned and read-only — never bind a control to it. A comment spanning two slots carries no slot. Act on the quoted passage, patch the slot it names, and confirm in one line.

Consequence for your renders: no `feedback.global` textarea, no per-section comment fields. Freeform review is covered, and the linter warns on any input bound to a `feedback.*`, `notes*`, `comment*`, or `review*` key.

## Decision points, not feedback prompts

Render a control only when the answer changes what you do next:

- an unresolved choice → radio group / select, then a checkpoint button
- work that must not continue unattended → checkpoint button
- a parameter you cannot infer (name, threshold, path) → one input

If a render has no open decision, it has no sidebar. A document with nothing to decide ends with nothing but the document.

## Tool reference

- `canvas_render({ selector, html, mode })` — result lists declared `slots` and may include design-lint `warnings`; **fix warnings in your next render**
- `canvas_read_signals({ keys? })` — values the user typed or picked, including `comments`
- `canvas_wait_for_event({ name?, timeoutMs? })` — block until a checkpoint is clicked

## Allowed selectors

- built-ins: `#root`, `#status`, `#sidebar`
- ids of the form `#canvas-...`
- `[data-canvas-slot]` and `[data-canvas-slot="name"]`

Avoid arbitrary selectors like `div` or random `#notes`.

## Render modes

`inner` (default) replaces contents, `outer` replaces the element, `append`/`prepend` add content.

Lay `#root` out once with named slots, then patch the slot that changed with `inner`. Never replace a node containing input the user may be typing into. Do not repeatedly append to `#root`.

## Composition rules

1. `#status` is one line under ~100 characters: current phase. Never content.
2. `#sidebar` holds decision controls only — never documents, code, or generic feedback.
3. `#root` is one coherent document laid out with named `data-canvas-slot` sections.
4. Prose goes in `<markdown-block>`; never hand-write `<p>`-heavy HTML or `<table>` markup.
5. Every input carries `data-signal`; every button carries `data-event`. Otherwise it is dead UI.
6. Only documented helper classes exist. Unknown classes are unstyled and lint-warned.
7. One idea per screen. Past ~two viewports, split into slots or move detail into `<details>`.
8. `.card` means bounded hierarchy, not default section chrome. Plain sections are the default.
9. Concise button labels (~3 words), consecutive heading levels.

## Event model

- Quiet sync: `data-signal` updates only, no transcript message
- Attention: `data-event="attention:<name>"` posts a concise summary; steers you if you are active. Selection comments arrive this way.
- Checkpoint: `data-event="checkpoint:<name>"` resolves a pending `canvas_wait_for_event`; otherwise delivered as a chat message (never both)

Button semantics are visual too: checkpoint renders filled primary, attention renders accent outline.

## Reactive attributes

Bare signal keys only (optionally negated with `!`), no expressions:

- `data-show="choice.backend"` — visible while the signal is non-empty (`!` inverts)
- `data-enable-when="choice.backend"` — disabled until the signal is non-empty

## Signal naming

- `choice.<id>` — a decision the user made
- `value.<id>` — a parameter you asked for
- `comments` — reserved: selection comments

## Styling rules

Semantic HTML is auto-styled; helper classes add layout intent only. Complete vocabulary:

| Class | Use |
| --- | --- |
| `card` | raised container for a bounded unit |
| `callout` | accent-edged aside; combine with `success` / `danger` / `info` |
| `warning` | caution callout |
| `grid` | responsive multi-column |
| `stack` | vertical group, even gaps |
| `row` | horizontal cluster |
| `toolbar` | right-aligned action strip |
| `field` | label + control block |
| `muted` | secondary text |
| `badge` | status pill; combine with `success` / `danger` / `warning` / `info` |
| `btn-primary` / `btn-quiet` | button emphasis when not using data-event semantics |

`<style>` blocks and inline styles are stripped by the sanitizer.

## Snippets

Markdown (always use this for prose, tables, lists):

```html
<markdown-block>| Option | Ops cost | Fit |
| --- | --- | --- |
| SQLite | low | default |
| Postgres | medium | concurrent writers |
</markdown-block>
```

Markdown source is element text: escape literal `<` as `&lt;`; raw HTML inside is sanitized away.

Mermaid:

```html
<mermaid-diagram>
graph TD
  A[Draft] --> B[Review]
  B --> C[Revise]
</mermaid-diagram>
```

Code and diff:

```html
<code-block language="ts">const ok = true;</code-block>
<code-block language="diff">@@ -1,2 +1,2 @@
-old behavior
+new behavior
</code-block>
```

Decision control (the only standard sidebar shape):

```html
<section id="canvas-decision" data-canvas-slot="decision">
  <h3>Open decision</h3>
  <fieldset>
    <legend>Storage backend</legend>
    <label><input type="radio" name="backend" value="sqlite" data-signal="choice.backend" /> SQLite</label>
    <label><input type="radio" name="backend" value="postgres" data-signal="choice.backend" /> Postgres</label>
  </fieldset>
  <div class="toolbar">
    <button data-event="checkpoint:pick_backend" data-enable-when="choice.backend">Confirm choice</button>
  </div>
</section>
```

## Recipes

Copy the closest recipe and adapt content.

### Recipe: spec review

Headline, evidence, one slot per section; sidebar only if something must be decided.

```html
<!-- canvas_render("#status", ...) -->
Spec draft 1 — auth token refresh

<!-- canvas_render("#root", ...) -->
<article id="canvas-spec" data-canvas-slot="spec">
  <h1>Auth token refresh <span class="badge warning">draft</span></h1>

  <section id="canvas-scope" data-canvas-slot="scope">
    <h2>Scope</h2>
    <markdown-block>| In | Out |
| --- | --- |
| refresh on 401 | SSO federation |
| retry once | device binding |</markdown-block>
  </section>

  <section id="canvas-design" data-canvas-slot="design">
    <h2>Design</h2>
    <mermaid-diagram>sequenceDiagram
  Client->>API: refresh(token)
  API-->>Client: 200 {token'}</mermaid-diagram>
    <aside class="callout warning">Second 401 bails instead of looping.</aside>
  </section>
</article>
```

Revise by patching one slot: `canvas_render("[data-canvas-slot=\"design\"]", ..., "inner")`, then flip its badge to `success`.

### Recipe: option picker

```html
<section id="canvas-options" data-canvas-slot="options">
  <h1>Storage backend</h1>
  <markdown-block>| Option | Ops | Ceiling | Note |
| --- | --- | --- | --- |
| SQLite | none | ~1k writes/s | recommended |
| Postgres | daemon + backups | high | needed for concurrent writers |</markdown-block>
  <fieldset>
    <legend>Your pick</legend>
    <label><input type="radio" name="backend" value="sqlite" data-signal="choice.backend" /> SQLite</label>
    <label><input type="radio" name="backend" value="postgres" data-signal="choice.backend" /> Postgres</label>
  </fieldset>
  <div class="toolbar">
    <button data-event="checkpoint:pick_backend" data-enable-when="choice.backend">Confirm choice</button>
  </div>
</section>
```

Then `canvas_wait_for_event({ name: "pick_backend" })` — the resolved event carries a signals snapshot.

### Recipe: diff walkthrough

```html
<section id="canvas-walkthrough" data-canvas-slot="walkthrough">
  <h1>Change walkthrough</h1>
  <section id="canvas-hunk-1" data-canvas-slot="hunk-1">
    <h2>1 — retry on 401 <span class="badge">src/auth.ts</span></h2>
    <code-block language="diff">@@ -12,3 +12,6 @@
-const res = await fetch(url);
+const res = await fetchWithRetry(url, { on: [401] });</code-block>
  </section>
  <!-- one slot per hunk; users comment by selecting the lines they mean -->
  <div class="toolbar">
    <button data-event="checkpoint:lgtm">Looks good</button>
  </div>
</section>
```

### Recipe: plan approval

```html
<section id="canvas-plan" data-canvas-slot="plan">
  <h1>Plan: migrate config loader</h1>
  <markdown-block>1. Extract `loadConfig` behind an interface
2. Add env-file source with tests
3. Cut over call sites, delete legacy parser</markdown-block>
  <aside class="callout warning">Step 3 touches 14 call sites — riskiest part.</aside>
  <div class="toolbar">
    <button data-event="checkpoint:approve_plan">Approve &amp; start</button>
  </div>
</section>
```

## Anti-patterns

- walls of prose where a table, diagram, or diff would carry the same content
- a generic feedback textarea or per-section comment boxes (selection comments already exist)
- a sidebar rendered out of habit when nothing is undecided
- dumping long markdown in chat while canvas is open
- hand-writing HTML prose or tables instead of `<markdown-block>`
- inventing class names or layouts instead of using a recipe
- wrapping every section in a card
- replacing a parent node that contains active input
- repeatedly appending to `#root` instead of patching named slots
- putting documents or code in `#sidebar`
- posting raw full JSON summaries to transcript
- opening a browser without `/canvas on` or `/canvas open`
- ignoring `warnings` returned by `canvas_render`
- exporting outside the current working directory (`/canvas export [path]` rejects escaping paths)

## Worked example

1. User runs `/canvas on`.
2. You render: status line, `#root` with a scope table, a mermaid flow, a diff — no sidebar, since nothing is undecided yet.
3. User selects a line in the diff and comments; you receive the quote and the note.
4. You patch only that slot and reply in one line.
5. A real fork appears: you render the option picker and call `canvas_wait_for_event({ name: "pick_backend" })`.
6. User confirms; the wait resolves with the choice.
7. You write the final file, using the comments and the choice recorded in chat.
