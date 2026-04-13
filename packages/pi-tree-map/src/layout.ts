import { COL_GAP, NODE_H, NODE_W_DEFAULT, ROW_GAP } from "./constants.js";
import type { TreeMapModel } from "./model.js";

function clampNodeWidth(viewWidth: number): number {
	if (!viewWidth || viewWidth < 80) return 20;
	return Math.max(20, Math.min(NODE_W_DEFAULT, Math.floor(viewWidth * 0.35)));
}

export function layoutTree(model: TreeMapModel, viewportWidth: number): TreeMapModel {
	const nodeById = new Map(model.nodes.map((n) => [n.nodeId, n]));
	const root = nodeById.get(model.rootNodeId);
	if (!root) return model;

	const nodeW = clampNodeWidth(viewportWidth);
	const xStep = nodeW + COL_GAP;
	const yStep = NODE_H + ROW_GAP;

	const childrenById = new Map<string, string[]>();
	for (const node of model.nodes) childrenById.set(node.nodeId, node.childNodeIds);

	const assignDepth = (id: string, depth: number): void => {
		const node = nodeById.get(id);
		if (!node) return;
		node.depth = depth;
		node.x = depth * xStep;
		node.w = nodeW;
		node.h = NODE_H;
		for (const childId of childrenById.get(id) || []) assignDepth(childId, depth + 1);
	};

	let cursorY = 0;
	const assignY = (id: string): number => {
		const node = nodeById.get(id);
		if (!node) return cursorY;
		const children = childrenById.get(id) || [];
		if (children.length === 0) {
			node.y = cursorY;
			cursorY += yStep;
			return node.y;
		}

		const ys = children.map((childId) => assignY(childId));
		node.y = Math.round((Math.min(...ys) + Math.max(...ys)) / 2);
		return node.y;
	};

	assignDepth(model.rootNodeId, 0);
	assignY(model.rootNodeId);

	// Simple collision pass per depth column
	const byDepth = new Map<number, typeof model.nodes>();
	for (const n of model.nodes) {
		if (!byDepth.has(n.depth)) byDepth.set(n.depth, []);
		byDepth.get(n.depth)!.push(n);
	}
	for (const [, col] of byDepth) {
		col.sort((a, b) => a.y - b.y);
		for (let i = 1; i < col.length; i++) {
			const prev = col[i - 1];
			const cur = col[i];
			const minY = prev.y + yStep;
			if (cur.y < minY) cur.y = minY;
		}
	}

	return model;
}
