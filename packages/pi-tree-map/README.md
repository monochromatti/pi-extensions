# @monochromatti/pi-tree-map

Pi extension that adds `/map`: an interactive terminal tree-map view of the current session graph.

Nodes are compact squares: larger squares mark user messages, smaller squares mark assistant replies that contain visible text. Branch summaries are also shown as navigable nodes. Tool calls, tool results, and thinking-only steps stay out of map nodes. Details show in modal below map.

## Load

```bash
pi -e /Users/monochromatti/code/pi-extensions/packages/pi-tree-map
```

## Command

- `/map` — open tree map

## Controls

- `↑↓←→` move selection
- `Enter` jump to selected node/branch
- `L` cycle title display mode
- `F` cycle filter mode
- `Esc` close
