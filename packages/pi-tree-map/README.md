# @monochromatti/pi-tree-map

Pi extension that adds `/map`: an interactive terminal tree-map view of the current session graph.

Nodes are compact squares (one per user message and branch summary), with details shown in the modal below the map.

## Load

```bash
pi -e /Users/monochromatti/code/pi-extensions/packages/pi-tree-map
```

## Command

- `/map` — open tree map

## Controls

- `↑↓←→` move selection
- `Enter` jump to selected branch
- `L` cycle title display mode
- `F` cycle filter mode
- `A` toggle auto-labeling for unlabeled map nodes
- `Esc` close
