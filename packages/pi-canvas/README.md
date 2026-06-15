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

Primary entrypoint: `/canvas`.

Quick showcase entrypoint: `/canvas-demo`.

`/canvas` behavior:

- starts local server (`127.0.0.1`) if needed
- prints Canvas URL in CLI
- attempts browser open first time per session
- reuses existing session canvas on later calls
- prints fallback workflow guidance (prompt injection caveat)

`/canvas-demo` behavior:

- does everything `/canvas` does
- renders a starter showcase into `#status`, `#root`, and `#sidebar`
- includes Mermaid, diff code block, and interactive feedback controls

## Tool surface

Only three tools exposed:

- `render({ selector, html, mode })`
- `read_signals({ keys? })`
- `wait_for_event({ name?, timeoutMs? })`

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

- `<code-block language="ts">...` with copy button
- `<code-block language="diff">...` for unified diff markers
- `<mermaid-diagram>...</mermaid-diagram>` with pinned loader path and safe fallback

## Security

Security posture is local-trust with explicit network constraints.

- bind server to `127.0.0.1`
- random session token required for routes
- mutation endpoints validate loopback `Origin` when present
- CSP returned on HTML/assets
- non-allowlisted remote assets blocked by sanitizer
- strips/rejects obvious unsafe HTML (`<script>`, `<style>`, inline handlers, `javascript:` URLs)

## Network policy

Current allowlisted asset origins:

- `http://127.0.0.1`
- `https://cdn.jsdelivr.net`
- `https://unpkg.com`

## Tests

Run package tests:

```bash
npm run test --workspace packages/pi-canvas
```

Coverage currently includes session/events, server routes, render/sanitizer, browser-style integration, extension lifecycle, style/doc static checks.

## MVP demo script

High-level acceptance flow:

1. install and enable `@monochromatti/pi-canvas`
2. run `/canvas`
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

Diff snippet:

```html
<code-block language="diff">@@ -1,2 +1,2 @@
-old behavior
+new behavior
</code-block>
```

## `/canvas` guidance caveat (6.10)

Prompt injection API may be unavailable in host Pi runtime.
When unavailable, `/canvas` falls back to explicit guidance line after URL (`render`, `read_signals`, `wait_for_event`).

## Current render transport (v1 simplification)

Browser runtime currently uses polling client (`static/client.js`) against `GET /patches`.
Public behavior mirrors planned patch semantics; transport can move to SSE/Datastar later without changing tool API.
