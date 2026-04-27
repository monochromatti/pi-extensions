import type { Theme } from "@mariozechner/pi-coding-agent";
import { matchesKey } from "@mariozechner/pi-tui";
import { FOOTER_TEXT } from "./constants.js";
import { moveSelection } from "./navigation.js";
import { getTreeMapThemeSignature, renderTreeMap, type CameraState } from "./render-canvas.js";
import type { FilterMode, LabelMode, TreeMapModel } from "./model.js";

interface TreeMapComponentOptions {
	tui: { requestRender: () => void; terminal: { rows: number } };
	getModel: () => TreeMapModel;
	getTheme: () => Theme;
	getSelectedNodeId: () => string;
	setSelectedNodeId: (id: string) => void;
	getLabelMode: () => LabelMode;
	getFilterMode: () => FilterMode;
	onEnter: (nodeId: string) => Promise<void>;
	onClose: () => void;
	onCycleLabel: () => Promise<void>;
	onCycleFilter: () => Promise<void>;
}

export class TreeMapComponent {
	private readonly opts: TreeMapComponentOptions;
	private readonly camera: CameraState = { cameraX: 0, cameraY: 0 };
	private cacheWidth = 0;
	private cacheHeight = 0;
	private cacheVersion = -1;
	private cacheThemeSignature = "";
	private version = 0;
	private cached: string[] = [];
	private busy = false;

	constructor(opts: TreeMapComponentOptions) {
		this.opts = opts;
	}

	invalidate(): void {
		this.version += 1;
		this.cacheWidth = 0;
		this.cacheHeight = 0;
	}

	render(width: number): string[] {
		const height = Math.max(6, this.opts.tui.terminal.rows || 24);
		const theme = this.opts.getTheme();
		const themeSignature = getTreeMapThemeSignature(theme);
		if (
			width === this.cacheWidth &&
			height === this.cacheHeight &&
			this.cacheVersion === this.version &&
			this.cacheThemeSignature === themeSignature
		) {
			return this.cached;
		}
		const model = this.opts.getModel();
		const selectedId = this.opts.getSelectedNodeId();
		const status = this.busy ? "Working..." : `${FOOTER_TEXT} | Mode:${this.opts.getLabelMode()} | Filter:${this.opts.getFilterMode()}`;
		this.cached = renderTreeMap(model, selectedId, this.camera, width, height, status, theme);
		this.cacheWidth = width;
		this.cacheHeight = height;
		this.cacheVersion = this.version;
		this.cacheThemeSignature = themeSignature;
		return this.cached;
	}

	handleInput(data: string): void {
		if (this.busy) return;
		const model = this.opts.getModel();
		const selected = this.opts.getSelectedNodeId();

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.opts.onClose();
			return;
		}

		if (matchesKey(data, "up")) {
			this.move(model, selected, "up");
			return;
		}
		if (matchesKey(data, "down")) {
			this.move(model, selected, "down");
			return;
		}
		if (matchesKey(data, "left")) {
			this.move(model, selected, "left");
			return;
		}
		if (matchesKey(data, "right")) {
			this.move(model, selected, "right");
			return;
		}

		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			if (!model.nodes.some((node) => node.nodeId === selected)) return;
			void this.withBusy(async () => {
				await this.opts.onEnter(selected);
			});
			return;
		}

		if (data === "l" || data === "L") {
			void this.withBusy(async () => {
				await this.opts.onCycleLabel();
				this.invalidate();
			});
			return;
		}
		if (data === "f" || data === "F") {
			void this.withBusy(async () => {
				await this.opts.onCycleFilter();
				this.invalidate();
			});
			return;
		}
	}

	dispose(): void {
		// no-op
	}

	private async withBusy(fn: () => Promise<void>): Promise<void> {
		this.busy = true;
		this.invalidate();
		this.opts.tui.requestRender();
		try {
			await fn();
		} finally {
			this.busy = false;
			this.invalidate();
			this.opts.tui.requestRender();
		}
	}

	private move(model: TreeMapModel, selected: string, direction: "left" | "right" | "up" | "down"): void {
		const next = moveSelection(model, selected, direction);
		if (next !== selected) {
			this.opts.setSelectedNodeId(next);
			this.invalidate();
			this.opts.tui.requestRender();
		}
	}
}
