import { COL_GAP, NODE_H, NODE_W_DEFAULT, ROW_GAP, USER_NODE_H, USER_NODE_W } from "./constants.js";
import type { TreeMapModel } from "./model.js";

function getNodeWidth(_viewportWidth: number): number {
	return NODE_W_DEFAULT;
}

export function layoutTree(model: TreeMapModel, viewportWidth: number): TreeMapModel {
	if (model.nodes.length === 0) return model;

	const nodes = model.nodes.map((node) => ({ ...node }));
	const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
	const nodeW = getNodeWidth(viewportWidth);
	for (const node of nodes) {
		node.w = node.messageRole === "user" ? USER_NODE_W : nodeW;
		node.h = node.messageRole === "user" ? USER_NODE_H : NODE_H;
	}
	// Reserve tallest node height for every leaf row. This keeps disjoint
	// subtrees collision-free without post-layout shifts that bend connectors.
	const rowStep = Math.max(...nodes.map((node) => node.h)) + ROW_GAP;

	const childrenById = new Map<string, string[]>();
	for (const node of nodes) childrenById.set(node.nodeId, node.childNodeIds);

	const assignDepth = (id: string, depth: number): void => {
		const node = nodeById.get(id);
		if (!node) return;
		node.depth = depth;
		for (const childId of childrenById.get(id) || []) assignDepth(childId, depth + 1);
	};

	let cursorY = 0;
	const assignY = (id: string): number => {
		const node = nodeById.get(id);
		if (!node) return cursorY;
		const children = childrenById.get(id) || [];
		if (children.length === 0) {
			node.y = cursorY;
			cursorY += rowStep;
			return node.y;
		}

		const ys = children.map((childId) => assignY(childId));
		// Center parent connector on child boxes, not their top edges. This keeps
		// mixed-height user/assistant nodes visually aligned.
		const childCenters = children.map((childId) => {
			const child = nodeById.get(childId);
			return child ? child.y + Math.floor(child.h / 2) : 0;
		});
		node.y = Math.round((Math.min(...childCenters) + Math.max(...childCenters)) / 2) - Math.floor(node.h / 2);
		return node.y;
	};

	const rootIds = nodes
		.filter((node) => !node.parentNodeId || !nodeById.has(node.parentNodeId))
		.map((node) => node.nodeId);
	const orderedRootIds = rootIds.length > 0 ? rootIds : [model.rootNodeId].filter(Boolean);

	for (const rootId of orderedRootIds) {
		assignDepth(rootId, 0);
		assignY(rootId);
	}

	const minY = Math.min(...nodes.map((node) => node.y));
	if (minY < 0) {
		for (const node of nodes) node.y -= minY;
	}

	const columnWidths = new Map<number, number>();
	for (const node of nodes) columnWidths.set(node.depth, Math.max(columnWidths.get(node.depth) || 0, node.w));
	const columnX = new Map<number, number>();
	let x = 0;
	for (let depth = 0; depth <= nodes.length; depth++) {
		if (!columnWidths.has(depth)) continue;
		columnX.set(depth, x);
		x += columnWidths.get(depth)! + COL_GAP;
	}
	for (const node of nodes) node.x = columnX.get(node.depth) || 0;

	return { ...model, nodes };
}
