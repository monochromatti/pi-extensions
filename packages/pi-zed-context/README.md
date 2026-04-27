# pi-zed-context

Pi extension exposing a `zed_context` tool. It reads Zed's local SQLite DB to report active file, cursor, and selected line range for the Zed workspace matching Pi's cwd.

## Requirements

- `sqlite3` CLI on PATH (`/usr/bin/sqlite3` on macOS works)
- Zed stable/preview/dev DB present, or set `PI_ZED_CONTEXT_DB=/path/to/db.sqlite`

## Tool

`zed_context` returns:

- Zed DB path used
- active file path
- workspace paths from Zed
- cursor/selection start/end line + character
- all disjoint selections in the active buffer as `selections[]`
- selected text, truncated by `maxTextChars` across selections

## Command

`/zed-context` shows current detected Zed context in Pi UI.

## Skill

Includes `zed-context` skill. It tells the agent to call `zed_context` when the user references the current/open Zed file, cursor, selected text, selection, or selected lines.
