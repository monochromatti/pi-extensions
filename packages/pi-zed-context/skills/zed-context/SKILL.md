---
name: zed-context
description: Use when user refers to currently open file, active Zed tab, cursor, selected text, selection, or selected lines in Zed. Teaches use of zed_context tool.
---

# Zed Context

When user references current/open file, active Zed tab, cursor, selected text, selection, or selected lines, call `zed_context` before answering.

Use returned `filePath`, `selections[]` (or first `selection`), line ranges, and `selectedText` as source of truth. If no workspace match, ask user or retry with `allowUnmatchedWorkspace: true` only if reasonable.
