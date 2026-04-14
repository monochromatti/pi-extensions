# @monochromatti/pi-auto-label

Pi extension that generates short persisted AI labels for the same structural session nodes used by `/map`.

The labels are written with `pi.setLabel(entryId, label)`, so they show up in `/tree` and are reused by `/map` smart labels.

## Load

```bash
pi -e /path/to/pi-extensions/packages/pi-auto-label
```

Or add the package to your Pi extensions configuration.

## Behavior

- On every `turn_end`, the extension finds the latest unlabeled structural `/map` node that is a `user` or `assistant` message
- If that entry already has a label, it does nothing
- Otherwise it generates a short 2-5 word label in Sentence case with `anthropic/claude-haiku-4-5`
- The generated label is persisted with `pi.setLabel(...)`
- Existing labels are never overwritten

The prompt uses a small recent window from the node path to the root so labels reflect the current branch context, not just a single assistant message.

## Command

- `/autolabel-backfill` — scan the session for unlabeled `/map` nodes and persist labels for them

Backfill is conservative:

- it only considers structural nodes that are `user` or `assistant` messages
- it skips nodes that already have labels
- it does not overwrite manual labels
- it shares in-flight work with `/map` so the same node is not labeled twice concurrently

## `/map` integration

`/map` no longer invents temporary in-memory AI labels for unlabeled nodes.
Instead, it requests persisted labels from the same auto-labeling logic and then uses the saved result.

## Notes

- Labels persist in the session file and survive restarts
- If the configured model or auth is unavailable, automatic labeling quietly skips work
- `/autolabel-backfill` reports when model/auth is unavailable
