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

`/canvas-demo` behavior:

- does everything `/canvas open` does
- renders a starter showcase into `#status`, `#root`, and `#sidebar`
- includes markdown, Mermaid, diff code block, and interactive feedback controls

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

## Events

- Quiet signal sync (`data-signal` inputs) never messages the transcript.
- `data-event="attention:<name>"` buttons post a concise transcript summary; steers the agent mid-turn when it is streaming.
- `data-event="checkpoint:<name>"` buttons resolve a pending `canvas_wait_for_event`; when none is pending, the checkpoint arrives as a chat message instead (never both).

## Reactive attributes

Declarative client-side reactivity bound to the signal store — a bare signal key only (optional `!` negation), never expressions, so agent HTML cannot execute logic:

- `data-show="<signal key>"` — element visible while the signal is non-empty
- `data-enable-when="<signal key>"` — control disabled until the signal is non-empty

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
8. user submits section feedback in canvas
9. explicit feedback appears as concise chat/transcript summary
10. agent revises section with targeted render update
11. user asks: create `SPEC.md` from feedback
12. agent writes final file from summarized canvas feedback

## Helper snippets

Section feedback snippet:

```html
<section id="canvas-scope" data-canvas-slot="scope">
  <h3>Scope</h3>
  <textarea data-signal="feedback.section.scope"></textarea>
  <button data-event="attention:revise_scope">Revise this section</button>
  <button data-event="checkpoint:approve_scope" data-payload='{"source":"button"}'>Approve</button>
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
