import type { Theme } from "@mariozechner/pi-coding-agent";
import { FOOTER_TEXT, NODE_H } from "./constants.js";
import { truncate } from "./format.js";
import type { MapNode, TreeMapModel } from "./model.js";

export interface CameraState {
	cameraX: number;
	cameraY: number;
}

function blankCanvas(width: number, height: number): string[][] {
	return Array.from({ length: height }, () => Array.from({ length: width }, () => " "));
}

function inBounds(canvas: string[][], x: number, y: number): boolean {
	return y >= 0 && y < canvas.length && x >= 0 && x < (canvas[0]?.length || 0);
}

const DIR_UP = 1;
const DIR_RIGHT = 2;
const DIR_DOWN = 4;
const DIR_LEFT = 8;

const MASK_TO_BOX = new Map<number, string>([
	[DIR_LEFT, "─"],
	[DIR_RIGHT, "─"],
	[DIR_UP, "│"],
	[DIR_DOWN, "│"],
	[DIR_LEFT | DIR_RIGHT, "─"],
	[DIR_UP | DIR_DOWN, "│"],
	[DIR_RIGHT | DIR_DOWN, "┌"],
	[DIR_LEFT | DIR_DOWN, "┐"],
	[DIR_UP | DIR_RIGHT, "└"],
	[DIR_UP | DIR_LEFT, "┘"],
	[DIR_UP | DIR_DOWN | DIR_RIGHT, "├"],
	[DIR_UP | DIR_DOWN | DIR_LEFT, "┤"],
	[DIR_LEFT | DIR_RIGHT | DIR_DOWN, "┬"],
	[DIR_LEFT | DIR_RIGHT | DIR_UP, "┴"],
	[DIR_UP | DIR_RIGHT | DIR_DOWN | DIR_LEFT, "┼"],
]);

const BOX_TO_MASK = new Map<string, number>([
	["─", DIR_LEFT | DIR_RIGHT],
	["│", DIR_UP | DIR_DOWN],
	["┌", DIR_RIGHT | DIR_DOWN],
	["┐", DIR_LEFT | DIR_DOWN],
	["└", DIR_UP | DIR_RIGHT],
	["┘", DIR_UP | DIR_LEFT],
	["├", DIR_UP | DIR_DOWN | DIR_RIGHT],
	["┤", DIR_UP | DIR_DOWN | DIR_LEFT],
	["┬", DIR_LEFT | DIR_RIGHT | DIR_DOWN],
	["┴", DIR_LEFT | DIR_RIGHT | DIR_UP],
	["┼", DIR_UP | DIR_RIGHT | DIR_DOWN | DIR_LEFT],
]);

function put(canvas: string[][], x: number, y: number, ch: string): void {
	if (!inBounds(canvas, x, y)) return;
	canvas[y][x] = ch;
}

function text(canvas: string[][], x: number, y: number, s: string): void {
	for (let i = 0; i < s.length; i++) put(canvas, x + i, y, s[i]!);
}

function putLine(canvas: string[][], x: number, y: number, mask: number): void {
	if (!inBounds(canvas, x, y) || mask === 0) return;
	const prev = canvas[y][x]!;
	if (prev !== " ") {
		const prevMask = BOX_TO_MASK.get(prev);
		if (prevMask === undefined) return;
		mask |= prevMask;
	}
	canvas[y][x] = MASK_TO_BOX.get(mask) || prev;
}

function drawH(canvas: string[][], x1: number, x2: number, y: number): void {
	const start = Math.min(x1, x2);
	const end = Math.max(x1, x2);
	for (let x = start; x <= end; x++) {
		let mask = 0;
		if (x > start) mask |= DIR_LEFT;
		if (x < end) mask |= DIR_RIGHT;
		if (mask === 0) mask = DIR_LEFT | DIR_RIGHT;
		putLine(canvas, x, y, mask);
	}
}

function drawV(canvas: string[][], x: number, y1: number, y2: number): void {
	const start = Math.min(y1, y2);
	const end = Math.max(y1, y2);
	for (let y = start; y <= end; y++) {
		let mask = 0;
		if (y > start) mask |= DIR_UP;
		if (y < end) mask |= DIR_DOWN;
		if (mask === 0) mask = DIR_UP | DIR_DOWN;
		putLine(canvas, x, y, mask);
	}
}

function getConnectorY(node: MapNode): number {
	return node.y + Math.floor(node.h / 2);
}

function drawEdgeGroup(canvas: string[][], parent: MapNode, children: MapNode[]): void {
	if (children.length === 0) return;
	const sortedChildren = [...children].sort((a, b) => getConnectorY(a) - getConnectorY(b));
	const startX = parent.x + parent.w;
	const endX = Math.min(...sortedChildren.map((child) => child.x - 1));
	const parentY = getConnectorY(parent);

	if (endX < startX) return;

	if (sortedChildren.length === 1) {
		drawH(canvas, startX, endX, parentY);
		if (parentY !== getConnectorY(sortedChildren[0]!)) {
			drawV(canvas, endX, parentY, getConnectorY(sortedChildren[0]!));
		}
		return;
	}

	const trunkX = Math.max(startX + 1, Math.floor((startX + endX) / 2));
	const childYs = sortedChildren.map((child) => getConnectorY(child));
	const topY = Math.min(parentY, ...childYs);
	const bottomY = Math.max(parentY, ...childYs);

	drawH(canvas, startX, trunkX, parentY);
	drawV(canvas, trunkX, topY, bottomY);

	for (const child of sortedChildren) {
		drawH(canvas, trunkX, child.x - 1, getConnectorY(child));
	}
}

function drawNode(canvas: string[][], node: MapNode): void {
	put(canvas, node.x, node.y, "■");
}

const RESET_STYLE = "\x1b[0m";

interface TreeMapStyles {
	currentNodeStyle: string;
	selectedNodeStyle: string;
	userRoleStyle: string;
	assistantRoleStyle: string;
	messageRoleStyle: string;
}

function getTreeMapStyles(theme: Theme): TreeMapStyles {
	return {
		currentNodeStyle: `${theme.getFgAnsi("success")}\x1b[1m`,
		selectedNodeStyle: `${theme.getFgAnsi("borderAccent")}\x1b[1m`,
		userRoleStyle: theme.getFgAnsi("accent"),
		assistantRoleStyle: theme.getFgAnsi("success"),
		messageRoleStyle: theme.getFgAnsi("border"),
	};
}

export function getTreeMapThemeSignature(theme: Theme): string {
	const styles = getTreeMapStyles(theme);
	return [styles.currentNodeStyle, styles.selectedNodeStyle, styles.userRoleStyle, styles.assistantRoleStyle, styles.messageRoleStyle].join("|");
}

function colorizeNonSpaceRange(line: string, start: number, endExclusive: number, style: string): string {
	if (start >= endExclusive || endExclusive <= 0 || start >= line.length) return line;
	const safeStart = Math.max(0, start);
	const safeEnd = Math.min(line.length, endExclusive);
	if (safeStart >= safeEnd) return line;

	let out = "";
	let styled = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i]!;
		const inRange = i >= safeStart && i < safeEnd;
		const shouldStyle = inRange && ch !== " ";
		if (shouldStyle && !styled) {
			out += style;
			styled = true;
		} else if (!shouldStyle && styled) {
			out += RESET_STYLE;
			styled = false;
		}
		out += ch;
	}
	if (styled) out += RESET_STYLE;
	return out;
}

function clamp(value: number, min: number, max: number): number {
	if (max < min) return min;
	return Math.max(min, Math.min(max, value));
}

function getBounds(nodes: MapNode[]): { minX: number; minY: number; maxX: number; maxY: number } {
	if (nodes.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const n of nodes) {
		minX = Math.min(minX, n.x);
		minY = Math.min(minY, n.y);
		maxX = Math.max(maxX, n.x + n.w - 1);
		maxY = Math.max(maxY, n.y + n.h - 1);
	}
	return { minX, minY, maxX, maxY };
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

function visibleLength(text: string): number {
	return stripAnsi(text).length;
}

function padAnsiRight(text: string, width: number): string {
	const len = visibleLength(text);
	if (len >= width) return text;
	return `${text}${" ".repeat(width - len)}`;
}

function clipNoEllipsis(text: string, max: number): string {
	if (max <= 0) return "";
	return text.length <= max ? text : text.slice(0, max);
}

function wrapText(textValue: string, width: number, maxLines: number): string[] {
	const text = textValue.trim();
	if (!text) return [""];
	if (width <= 1) return [text.slice(0, maxLines)];

	const words = text.split(/\s+/);
	const lines: string[] = [];
	let cur = "";

	for (const word of words) {
		const candidate = cur ? `${cur} ${word}` : word;
		if (candidate.length <= width) {
			cur = candidate;
			continue;
		}
		if (cur) {
			lines.push(cur);
			if (lines.length >= maxLines) return lines;
		}
		if (word.length > width) {
			lines.push(word.slice(0, width));
			if (lines.length >= maxLines) return lines;
			cur = word.slice(width);
		} else {
			cur = word;
		}
	}
	if (cur && lines.length < maxLines) lines.push(cur);
	return lines;
}

function buildSelectedModalLines(selected: MapNode, viewportWidth: number, maxHeight: number, theme: Theme): string[] {
	if (viewportWidth < 36 || maxHeight < 6) return [];

	const modalWidth = clamp(Math.floor(viewportWidth * 0.72), 42, Math.max(42, viewportWidth - 2));
	const contentWidth = Math.max(12, modalWidth - 4);
	const titleLines = wrapText(selected.title.replace(/\s+/g, " "), contentWidth, 2);
	const firstMessage = (selected.messageText || "(No message content available)").replace(/\s+/g, " ");
	const role =
		selected.messageRole === "assistant"
			? "assistant"
			: selected.messageRole === "user"
				? "user"
				: selected.messageRole === "branch_summary"
					? "branch_summary"
					: "message";
	const styles = getTreeMapStyles(theme);
	const roleColor =
		role === "user"
			? styles.userRoleStyle
			: role === "assistant"
				? styles.assistantRoleStyle
				: styles.messageRoleStyle;
	const reset = RESET_STYLE;

	const bodyCapacity = Math.max(4, maxHeight - 2);
	const bodyLines: string[] = [];
	for (const t of titleLines) bodyLines.push(clipNoEllipsis(t, contentWidth));
	bodyLines.push("");

	const remaining = Math.max(1, bodyCapacity - bodyLines.length);
	const prefixPlain = `${role}: `;
	const firstWidth = Math.max(1, contentWidth - prefixPlain.length);
	const wrapped = wrapText(firstMessage, contentWidth, remaining);
	if (wrapped.length > 0) {
		bodyLines.push(`${roleColor}${role}:${reset} ${clipNoEllipsis(wrapped[0] || "", firstWidth)}`);
		for (let i = 1; i < wrapped.length && bodyLines.length < bodyCapacity; i++) {
			bodyLines.push(`${" ".repeat(prefixPlain.length)}${clipNoEllipsis(wrapped[i] || "", Math.max(1, contentWidth - prefixPlain.length))}`);
		}
	}

	const clippedBody = bodyLines.slice(0, bodyCapacity);
	const box: string[] = [];
	box.push(`╭${"─".repeat(modalWidth - 2)}╮`);
	for (const body of clippedBody) {
		box.push(`│ ${padAnsiRight(body, contentWidth)} │`);
	}
	while (box.length < Math.max(1, maxHeight - 1)) {
		box.push(`│ ${" ".repeat(contentWidth)} │`);
	}
	box.push(`╰${"─".repeat(modalWidth - 2)}╯`);

	const leftPad = Math.max(0, Math.floor((viewportWidth - modalWidth) / 2));
	return box.map((line) => `${" ".repeat(leftPad)}${line}`.padEnd(viewportWidth, " "));
}

export function renderTreeMap(
	model: TreeMapModel,
	selectedNodeId: string,
	camera: CameraState,
	viewportWidth: number,
	viewportHeight: number,
	status: string,
	theme: Theme,
): string[] {
	const safeHeight = Math.max(6, viewportHeight);
	const nodeById = new Map(model.nodes.map((n) => [n.nodeId, n]));
	const selected = nodeById.get(selectedNodeId);
	const styles = getTreeMapStyles(theme);

	const footerHeight = 1;
	const maxModalHeight = Math.max(0, safeHeight - footerHeight - 6);
	const modalLines = selected ? buildSelectedModalLines(selected, viewportWidth, Math.min(9, maxModalHeight), theme) : [];
	const modalReserveExtra = modalLines.length > 0 ? 4 : 0;
	const belowAreaTarget = modalLines.length + modalReserveExtra;
	const mapHeight = Math.max(4, safeHeight - footerHeight - belowAreaTarget);

	const bounds = getBounds(model.nodes);
	const padding = 2;

	const contentW = bounds.maxX - bounds.minX + 1;
	const contentH = bounds.maxY - bounds.minY + 1;
	const fitsViewport = contentW + padding * 2 <= viewportWidth && contentH + padding * 2 <= mapHeight;

	let renderOffsetX = 0;
	let renderOffsetY = 0;

	if (fitsViewport) {
		camera.cameraX = 0;
		camera.cameraY = 0;
		renderOffsetX = Math.floor((viewportWidth - contentW) / 2) - bounds.minX;
		renderOffsetY = Math.floor((mapHeight - contentH) / 2) - bounds.minY;
	} else if (selected) {
		const targetX = selected.x + Math.floor(selected.w / 2) - Math.floor(viewportWidth / 2);
		const targetY = selected.y + Math.floor(NODE_H / 2) - Math.floor(mapHeight / 2);
		const maxCamX = Math.max(0, bounds.maxX + padding - viewportWidth + 1);
		const maxCamY = Math.max(0, bounds.maxY + padding - mapHeight + 1);
		camera.cameraX = clamp(targetX, 0, maxCamX);
		camera.cameraY = clamp(targetY, 0, maxCamY);
	}

	const drawNodes = model.nodes.map((n) => ({ ...n, x: n.x + renderOffsetX, y: n.y + renderOffsetY }));
	const drawNodeById = new Map(drawNodes.map((n) => [n.nodeId, n]));
	const selectedDrawNode = selected ? drawNodeById.get(selectedNodeId) : undefined;
	const currentDrawNode = drawNodes.find((node) => node.isCurrent);

	const maxX = drawNodes.reduce((m, n) => Math.max(m, n.x + n.w + 4), 0);
	const maxY = drawNodes.reduce((m, n) => Math.max(m, n.y + n.h + 2), 0);
	const worldW = Math.max(viewportWidth + camera.cameraX, maxX + 2);
	const worldH = Math.max(mapHeight + camera.cameraY, maxY + 2);
	const canvas = blankCanvas(worldW, worldH);

	const childrenByParentId = new Map<string, MapNode[]>();
	for (const edge of model.edges) {
		const from = drawNodeById.get(edge.fromNodeId);
		const to = drawNodeById.get(edge.toNodeId);
		if (!from || !to) continue;
		if (!childrenByParentId.has(from.nodeId)) childrenByParentId.set(from.nodeId, []);
		childrenByParentId.get(from.nodeId)!.push(to);
	}
	for (const [parentId, children] of childrenByParentId) {
		const parent = drawNodeById.get(parentId);
		if (!parent) continue;
		drawEdgeGroup(canvas, parent, children);
	}
	for (const node of drawNodes) {
		drawNode(canvas, node);
	}

	const lines: string[] = [];
	for (let row = 0; row < mapHeight; row++) {
		const worldRow = row + camera.cameraY;
		if (worldRow < 0 || worldRow >= canvas.length) {
			lines.push(" ".repeat(viewportWidth));
			continue;
		}
		const source = canvas[worldRow]!;
		let line = "";
		for (let col = 0; col < viewportWidth; col++) {
			const worldCol = col + camera.cameraX;
			line += worldCol >= 0 && worldCol < source.length ? source[worldCol] : " ";
		}
		if (currentDrawNode && worldRow >= currentDrawNode.y && worldRow < currentDrawNode.y + currentDrawNode.h) {
			const start = currentDrawNode.x - camera.cameraX;
			const endExclusive = currentDrawNode.x + currentDrawNode.w - camera.cameraX;
			line = colorizeNonSpaceRange(line, start, endExclusive, styles.currentNodeStyle);
		}
		if (
			selectedDrawNode &&
			worldRow >= selectedDrawNode.y &&
			worldRow < selectedDrawNode.y + selectedDrawNode.h &&
			(!currentDrawNode || selectedDrawNode.nodeId !== currentDrawNode.nodeId)
		) {
			const start = selectedDrawNode.x - camera.cameraX;
			const endExclusive = selectedDrawNode.x + selectedDrawNode.w - camera.cameraX;
			line = colorizeNonSpaceRange(line, start, endExclusive, styles.selectedNodeStyle);
		}
		lines.push(line);
	}

	if (modalLines.length > 0) {
		const belowArea = Math.max(0, safeHeight - footerHeight - mapHeight);
		const free = Math.max(0, belowArea - modalLines.length);
		const topPad = Math.floor(free / 2);
		const bottomPad = free - topPad;
		for (let i = 0; i < topPad; i++) lines.push(" ".repeat(viewportWidth));
		for (const modalLine of modalLines) lines.push(modalLine);
		for (let i = 0; i < bottomPad; i++) lines.push(" ".repeat(viewportWidth));
	}

	const footer = truncate(status || FOOTER_TEXT, Math.max(1, viewportWidth));
	lines.push(footer.padEnd(viewportWidth, " "));
	return lines;
}
