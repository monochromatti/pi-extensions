import type { FilterMode, LabelMode } from "./model.js";

export const COMMAND_NAME = "map";

export const LABEL_MODES: LabelMode[] = ["smart", "label", "id", "timestamp"];
export const FILTER_MODES: FilterMode[] = ["all", "user-only", "labeled-only"];

export const VIRTUAL_ROOT_ID = "__pi_tree_map_root__";

export const NODE_W_DEFAULT = 30;
export const NODE_H = 4;
export const COL_GAP = 8;
export const ROW_GAP = 2;

export const FOOTER_TEXT = "↑↓←→ Move | Enter Jump | Esc Close | L Labels | F Filter | A Auto-label";
