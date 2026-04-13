import type { MapNode, TreeMapModel } from "./model.js";

export type MoveDirection = "left" | "right" | "up" | "down";

function dist(a: MapNode, b: MapNode): number {
	return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function nearestBy(nodes: MapNode[], score: (n: MapNode) => number): MapNode | undefined {
	let best: MapNode | undefined;
	let bestScore = Number.POSITIVE_INFINITY;
	for (const n of nodes) {
		const s = score(n);
		if (s < bestScore) {
			best = n;
			bestScore = s;
		}
	}
	return best;
}

export function moveSelection(model: TreeMapModel, selectedNodeId: string, direction: MoveDirection): string {
	const selected = model.nodes.find((n) => n.nodeId === selectedNodeId);
	if (!selected) return selectedNodeId;

	if (direction === "left" && selected.parentNodeId) {
		return selected.parentNodeId;
	}
	if (direction === "right" && selected.childNodeIds.length > 0) {
		const children = selected.childNodeIds
			.map((id) => model.nodes.find((n) => n.nodeId === id))
			.filter((n): n is MapNode => !!n);
		const preferred = nearestBy(children, (n) => Math.abs(n.y - selected.y));
		return preferred?.nodeId || selectedNodeId;
	}

	if (direction === "up" || direction === "down") {
		const sameDepth = model.nodes.filter((n) => n.depth === selected.depth && n.nodeId !== selected.nodeId);
		const candidates = sameDepth.filter((n) => (direction === "up" ? n.y < selected.y : n.y > selected.y));
		const pick = nearestBy(candidates, (n) => dist(selected, n));
		if (pick) return pick.nodeId;

		const fallback = model.nodes.filter((n) =>
			direction === "up" ? n.y < selected.y && n.nodeId !== selected.nodeId : n.y > selected.y && n.nodeId !== selected.nodeId,
		);
		const fallbackPick = nearestBy(fallback, (n) => dist(selected, n));
		if (fallbackPick) return fallbackPick.nodeId;
	}

	if (direction === "left") {
		const left = model.nodes.filter((n) => n.x < selected.x);
		const pick = nearestBy(left, (n) => dist(selected, n));
		if (pick) return pick.nodeId;
	}
	if (direction === "right") {
		const right = model.nodes.filter((n) => n.x > selected.x);
		const pick = nearestBy(right, (n) => dist(selected, n));
		if (pick) return pick.nodeId;
	}

	return selectedNodeId;
}
