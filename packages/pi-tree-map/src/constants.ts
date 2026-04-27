import type { FilterMode, LabelMode } from "./model.js";

export const COMMAND_NAME = "map";

export const LABEL_MODES = ["smart", "label", "id", "timestamp"] as const satisfies readonly LabelMode[];
export const FILTER_MODES = ["all", "user-only", "labeled-only"] as const satisfies readonly FilterMode[];

export const NODE_W_DEFAULT = 1;
export const NODE_H = 1;
export const COL_GAP = 3;
export const ROW_GAP = 1;

export const FOOTER_TEXT = "↑↓←→ Move | Enter Jump | Esc Close | L Labels | F Filter";
