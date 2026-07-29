# @monochromatti/pi-canvas

Local in-memory collaboration canvas extension for Pi.

## Install

Workspace/local usage:

1. ensure package exists in repo workspaces (`packages/pi-canvas`)
2. ensure root `pi.extensions` includes `./packages/pi-canvas/index.ts` when you want auto-load in this repo
3. run checks:

```bash
npm run test --workspace packages/pi-canvas
```

## Use

Primary entrypoint: `/canvas on`.

Quick showcase entrypoint: `/canvas-demo`.

`/canvas on` behavior:

- starts local server (`127.0.0.1`) if needed
- prints Canvas URL in CLI
- opens the default browser first time per session (`$BROWSER` override respected; `xdg-open`/`open`/`start` otherwise)
- reuses existing session canvas on later calls
- prints fallback workflow guidance (prompt injection caveat)

`/canvas open` explicitly opens the browser again, starting and enabling canvas if needed. `/canvas off` disables canvas tools and stops the server. `/canvas status` reports enabled/running state. `/canvas stop` remains an alias for `off`. Bare `/canvas` prints usage and changes no state.

`/canvas export [path]` writes current canvas as a standalone static HTML file. Without a path it creates a timestamped `canvas-export-*.html` in the current working directory. Export works while the canvas server is stopped, preserves current signal values and local reactive controls, and disables attention/checkpoint buttons. It contains no session token, sync requests, polling, event backend, or runtime network dependency. Markdown and Mermaid runtimes are bundled into the exported file.

`/canvas-demo` behavior:

- does everything `/canvas open` does
- renders a compact showcase into `#status`, `#root`, and `#sidebar`
- includes a comparison table, Mermaid sequence diagram, diff code block, and one decision control

## Tool surface

Only three tools exposed:

- `canvas_render({ selector, html, mode })` — result includes declared `slots` and, when the design linter finds issues, `warnings`
- `canvas_read_signals({ keys? })`
- `canvas_wait_for_event({ name?, timeoutMs? })`

Each tool carries a `promptSnippet`/`promptGuidelines`, so the model discovers the canvas workflow from the system prompt without loading the skill.

## Design system

The canvas owns all visual design so agents never have to: bare semantic HTML (headings, tables, buttons, inputs, labels) is styled by `static/styles.css` — fixed black-and-white, shadcn-like light+dark surfaces, system-sans typography, IBM Plex Mono for code and labels, an app-shell grid with a sticky sidebar, and subtle patch-arrival motion. Decorative palettes are intentionally unavailable; color is reserved for semantic status.

Agents add layout intent only through a closed helper-class vocabulary: `card`, `callout`, `warning`, `success`, `danger`, `info`, `grid`, `stack`, `row`, `toolbar`, `field`, `muted`, `badge`, `btn-primary`, `btn-quiet`. Unknown classes and other design mistakes come back as `warnings` in the `canvas_render` result (see `src/lint.ts`): stripped inline styles, prose outside `<markdown-block>`, controls without `data-signal`, buttons without `data-event`, overlong `#status` lines, repeated appends to `#root`.

The linter also catches repetitive card chrome, long action labels, skipped heading levels, and large root documents without named patch slots. Cards are reserved for bounded hierarchy; plain document sections are the default.

Reading-load rules push agents toward compression instead of prose: paragraphs over ~450 characters, renders over ~1200 characters with no table/list/diagram/code, renders over ~5000 characters, feedback-style inputs, and three or more freeform text boxes all return warnings. Reading load counts prose only — code blocks, diagram source, table rows, and collapsed `<details>` are excluded, so structure is never penalized.

Checkpoint buttons (`data-event="checkpoint:..."`) automatically render as the filled primary action; attention buttons as accent outlines.

## Selectors and render modes

Allowed selectors:

- `#root`, `#status`, `#sidebar`
- `#canvas-*`
- `[data-canvas-slot]`
- `[data-canvas-slot="<declared>"]`

Render modes:

- `inner`
- `outer`
- `append`
- `prepend`

## Components

- `<markdown-block>...` renders markdown (pinned `marked` loader, sanitized output, plain-text fallback)
- `<code-block language="ts">...` with copy button
- `<code-block language="diff">...` for unified diff markers
- `<mermaid-diagram>...</mermaid-diagram>` with pinned loader path and safe fallback

## Selection comments

Users select any text in `#root` or `#sidebar`; a comment pill appears, and the note plus the quoted passage arrive as an attention event:

```text
Canvas comment [design] on "Refresh happens on the first 401.": Second 401 should bail.
```

Comments post to a dedicated `POST /comment` route rather than the generic attention endpoint. The server validates and normalizes the fields, assigns the index, appends to the session log, and marks the event `source: "selection-comment"` — a marker agent-rendered buttons cannot forge, so a render cannot inject text into the transcript as if the user wrote it.

The log lives in the signal store under `comments` (`{ index, slot, quote, note, at }`) and is server-owned: `/sync` cannot overwrite it, so reloads, extra tabs, and racing signal posts never drop history. Commented passages stay highlighted via the CSS Custom Highlight API (most recent 50). A selection spanning two slots reports no slot rather than guessing. The comment layer lives outside `#root`/`#sidebar`, so agent patches never destroy an in-progress comment, and `#canvas-comment-layer` is rejected as a render selector.

Because freeform review is built in, agents should not render generic feedback textareas; `src/lint.ts` warns when they do.

## Events

- Quiet signal sync (`data-signal` inputs) never messages the transcript.
- `data-event="attention:<name>"` buttons post a concise transcript summary; steers the agent mid-turn when it is streaming.
- `data-event="checkpoint:<name>"` buttons resolve a pending `canvas_wait_for_event`; when none is pending, the checkpoint arrives as a chat message instead (never both).

## Reactive attributes

Declarative client-side reactivity bound to the signal store — a bare signal key only (optional `!` negation), never expressions, so agent HTML cannot execute logic:

- `data-show="<signal key>"` — element visible while the signal is non-empty
- `data-enable-when="<signal key>"` — control disabled until the signal is non-empty

## Static export

```text
/canvas export
/canvas export ./artifacts/review.html
/canvas export "./artifacts/Canvas Review.html"
```

Export inlines the shell, design CSS, Markdown and Mermaid runtimes, component runtime, sanitized patch log, and current signal snapshot into one HTML file. Browser-side replay materializes the latest canvas state without running a server. Exported input controls retain local `data-show` and `data-enable-when` behavior; backend-dependent `data-event` controls are disabled. Output paths must remain inside the current working directory; quote paths containing spaces.

## Security

Security posture is local-trust with explicit network constraints.

- bind server to `127.0.0.1`
- random session token required for routes
- mutation endpoints validate loopback `Origin` when present
- CSP returned on HTML/assets
- non-allowlisted remote assets blocked by sanitizer
- strips/rejects obvious unsafe HTML (`<script>`, `<style>`, inline handlers, `javascript:` URLs)
- markdown rendered client-side is re-sanitized with the same rules

## Network policy

Current allowlisted asset origins:

- `http://127.0.0.1`
- `https://cdn.jsdelivr.net`
- `https://unpkg.com`

Scripts only load from the canvas itself plus pinned jsdelivr bundles (`mermaid`, `marked`).

## Tests

Run package tests:

```bash
npm run test --workspace packages/pi-canvas
```

Coverage currently includes session/events, server routes (including SSE), render/sanitizer, browser-style integration, extension lifecycle, browser-opener selection, style/doc static checks.

## MVP demo script

High-level acceptance flow:

1. install and enable `@monochromatti/pi-canvas`
2. run `/canvas on`
3. browser opens and CLI prints Canvas URL
4. empty-state appears in `#root`
5. ask agent for spec planning help
6. agent renders scaffold into canvas
7. agent streams sections, Mermaid diagram, and diff block
8. user selects text and submits section feedback as a canvas comment
9. explicit feedback appears as concise chat/transcript summary
10. agent revises section with targeted render update
11. user asks: create `SPEC.md` from feedback
12. agent writes final file from summarized canvas feedback

## Helper snippets

Decision snippet (controls exist for open decisions; freeform notes come from selection comments):

```html
<section id="canvas-decision" data-canvas-slot="decision">
  <h3>Open decision</h3>
  <fieldset>
    <legend>Storage backend</legend>
    <label><input type="radio" name="backend" value="sqlite" data-signal="choice.backend" /> SQLite</label>
    <label><input type="radio" name="backend" value="postgres" data-signal="choice.backend" /> Postgres</label>
  </fieldset>
  <button data-event="checkpoint:pick_backend" data-enable-when="choice.backend">Confirm choice</button>
</section>
```

Markdown snippet:

```html
<markdown-block>## Scope

- **In**: auth flow
- **Out**: SSO federation
</markdown-block>
```

Diff snippet:

```html
<code-block language="diff">@@ -1,2 +1,2 @@
-old behavior
+new behavior
</code-block>
```

## `/canvas on` guidance caveat (6.10)

Prompt injection API may be unavailable in host Pi runtime.
When unavailable, `/canvas on` falls back to explicit guidance line after URL (`canvas_render`, `canvas_read_signals`, `canvas_wait_for_event`).

## Render transport

Browser runtime prefers SSE (`GET /stream`) and falls back to adaptive polling against `GET /patches` when SSE is unavailable. Both paths dedupe by patch id, so append/prepend patches never double-apply.
