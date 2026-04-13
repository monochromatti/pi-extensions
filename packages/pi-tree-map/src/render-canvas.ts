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

const JOIN = new Map<string, string>([
	["─│", "┼"],
	["│─", "┼"],
	["├─", "├"],
	["┤─", "┤"],
	["─├", "├"],
	["─┤", "┤"],
	["─┼", "┼"],
	["│┼", "┼"],
]);

function put(canvas: string[][], x: number, y: number, ch: string): void {
	if (!inBounds(canvas, x, y)) return;
	const prev = canvas[y][x];
	if (prev === " " || prev === ch) {
		canvas[y][x] = ch;
		return;
	}
	const merged = JOIN.get(`${prev}${ch}`) || JOIN.get(`${ch}${prev}`) || ch;
	canvas[y][x] = merged;
}

function text(canvas: string[][], x: number, y: number, s: string): void {
	for (let i = 0; i < s.length; i++) put(canvas, x + i, y, s[i]!);
}

function drawH(canvas: string[][], x1: number, x2: number, y: number): void {
	const start = Math.min(x1, x2);
	const end = Math.max(x1, x2);
	for (let x = start; x <= end; x++) put(canvas, x, y, "─");
}

function drawV(canvas: string[][], x: number, y1: number, y2: number): void {
	const start = Math.min(y1, y2);
	const end = Math.max(y1, y2);
	for (let y = start; y <= end; y++) put(canvas, x, y, "│");
}

function drawEdge(canvas: string[][], from: MapNode, to: MapNode, label: string): void {
	const x1 = from.x + from.w;
	const y1 = from.y + 1;
	const x2 = to.x - 1;
	const y2 = to.y + 1;
	const midX = Math.max(x1 + 2, Math.floor((x1 + x2) / 2));

	drawH(canvas, x1, midX, y1);
	drawV(canvas, midX, y1, y2);
	drawH(canvas, midX, x2, y2);

	if (label) {
		const lx = Math.min(midX + 1, x2 - label.length - 1);
		text(canvas, Math.max(lx, x1 + 1), Math.min(y1, y2), truncate(label, 12));
	}
}

function drawNode(canvas: string[][], node: MapNode): void {
	const x = node.x;
	const y = node.y;
	const w = node.w;
	const marker = node.isCurrent ? "◆" : "●";

	text(canvas, x, y, `╭${"─".repeat(Math.max(0, w - 2))}╮`);
	text(canvas, x, y + NODE_H - 1, `╰${"─".repeat(Math.max(0, w - 2))}╯`);
	text(canvas, x, y + 1, `│${" ".repeat(Math.max(0, w - 2))}│`);
	text(canvas, x, y + 2, `│${" ".repeat(Math.max(0, w - 2))}│`);

	text(canvas, x + 1, y + 1, `${marker} ${truncate(node.title, Math.max(0, w - 5))}`);
	text(canvas, x + 1, y + 2, truncate(node.subtitle, Math.max(0, w - 3)));
}

const RESET_STYLE = "\x1b[0m";

interface TreeMapStyles {
	selectedNodeStyle: string;
	userRoleStyle: string;
	assistantRoleStyle: string;
	messageRoleStyle: string;
}

function getTreeMapStyles(theme: Theme): TreeMapStyles {
	return {
		selectedNodeStyle: `${theme.getFgAnsi("borderAccent")}\x1b[1m`,
		userRoleStyle: theme.getFgAnsi("accent"),
		assistantRoleStyle: theme.getFgAnsi("success"),
		messageRoleStyle: theme.getFgAnsi("border"),
	};
}

export function getTreeMapThemeSignature(theme: Theme): string {
	const styles = getTreeMapStyles(theme);
	return [styles.selectedNodeStyle, styles.userRoleStyle, styles.assistantRoleStyle, styles.messageRoleStyle].join("|");
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
	const firstMessage = (selected.firstBranchMessage || "(No message found in this branch segment)").replace(/\s+/g, " ");
	const role = selected.firstBranchMessageRole === "assistant" ? "assistant" : selected.firstBranchMessageRole === "user" ? "user" : "message";
	const styles = getTreeMapStyles(theme);
	const roleColor =
		role === "user" ? styles.userRoleStyle : role === "assistant" ? styles.assistantRoleStyle : styles.messageRoleStyle;
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

	const maxX = drawNodes.reduce((m, n) => Math.max(m, n.x + n.w + 4), 0);
	const maxY = drawNodes.reduce((m, n) => Math.max(m, n.y + n.h + 2), 0);
	const worldW = Math.max(viewportWidth + camera.cameraX, maxX + 2);
	const worldH = Math.max(mapHeight + camera.cameraY, maxY + 2);
	const canvas = blankCanvas(worldW, worldH);

	for (const edge of model.edges) {
		const from = drawNodeById.get(edge.fromNodeId);
		const to = drawNodeById.get(edge.toNodeId);
		if (!from || !to) continue;
		drawEdge(canvas, from, to, edge.label);
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
		if (selectedDrawNode && worldRow >= selectedDrawNode.y && worldRow < selectedDrawNode.y + selectedDrawNode.h) {
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
