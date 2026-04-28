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

## Commands

`/zed-context` shows current detected Zed context in Pi UI.

## `@zed:` references

In interactive Pi, type `@zed:` to autocomplete current Zed selections/open files.

Supported refs:

- `@zed:0` — first Zed editor selection in the current/open editor list
- `@zed:0:1` — second non-empty selection for editor 0
- `@zed:file:/absolute/or/workspace/path` — open file contents

Before sending input to the model, the extension expands refs into XML-ish blocks like `<zed-selection ...>` or `<zed-file ...>` using Zed's unsaved buffer contents when available.

## Skill

Includes `zed-context` skill. It tells the agent to call `zed_context` when the user references the current/open Zed file, cursor, selected text, selection, or selected lines.
