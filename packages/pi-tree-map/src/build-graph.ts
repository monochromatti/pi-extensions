import { VIRTUAL_ROOT_ID } from "./constants.js";
import { getTitle, summarizeEdge } from "./format.js";
import { analyzeTreeMapSnapshot } from "./graph-core.js";
import type { BuildGraphOptions, MapEdge, MapNode, RawEntry, Snapshot, TreeMapModel } from "./model.js";

interface Agg {
	entryCount: number;
	messageCount: number;
	userCount: number;
	assistantCount: number;
	toolCount: number;
	tokenCount: number;
}

function initAgg(): Agg {
	return {
		entryCount: 0,
		messageCount: 0,
		userCount: 0,
		assistantCount: 0,
		toolCount: 0,
		tokenCount: 0,
	};
}

function updateAgg(agg: Agg, entry: RawEntry): void {
	agg.entryCount += 1;
	if (entry.type === "message") {
		agg.messageCount += 1;
		const role = entry.message?.role;
		if (role === "user") agg.userCount += 1;
		if (role === "assistant") agg.assistantCount += 1;
	}
	if (entry.type.includes("tool")) {
		agg.toolCount += 1;
	}
	const tokenCount = entry.message?.usage?.totalTokens ?? entry.usage?.totalTokens;
	if (typeof tokenCount === "number" && Number.isFinite(tokenCount)) {
		agg.tokenCount += tokenCount;
	}
}

function nearestStructuralAncestor(id: string, parentById: Map<string, string | null>, structural: Set<string>): string | null {
	let parent = parentById.get(id) ?? null;
	while (parent && !structural.has(parent)) {
		parent = parentById.get(parent) ?? null;
	}
	return parent;
}

function extractMessageDetails(entry: RawEntry): { text?: string; role?: string } {
	if (entry.type !== "message") return {};
	const text = (entry.message?.content || [])
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text || "")
		.join("\n")
		.trim();
	return { text: text || undefined, role: entry.message?.role };
}

function extractNodeMessage(entry: RawEntry): { text?: string; role?: string } {
	if (entry.type === "branch_summary") {
		const text = entry.summary?.trim();
		return { text: text || undefined, role: "branch_summary" };
	}
	return extractMessageDetails(entry);
}

function collectSegmentEntries(
	childId: string,
	parentId: string,
	parentById: Map<string, string | null>,
	visibleEntries: Map<string, RawEntry>,
): RawEntry[] {
	const reversed: RawEntry[] = [];
	let cur: string | null = childId;
	while (cur && cur !== parentId) {
		const entry = visibleEntries.get(cur);
		if (entry && cur !== VIRTUAL_ROOT_ID) reversed.push(entry);
		cur = parentById.get(cur) ?? null;
	}
	reversed.reverse();
	return reversed;
}

export function buildTreeMapModel(snapshot: Snapshot, options: BuildGraphOptions): TreeMapModel {
	if (snapshot.entries.length === 0) {
		return { nodes: [], edges: [], rootNodeId: "" };
	}

	const analysis = analyzeTreeMapSnapshot(snapshot, options.filterMode);
	if (analysis.entries.length === 0) {
		return { nodes: [], edges: [], rootNodeId: "" };
	}

	let currentNodeId = analysis.currentLeaf;
	while (currentNodeId && !analysis.structural.has(currentNodeId)) {
		currentNodeId = analysis.parentById.get(currentNodeId) || undefined;
	}

	const structuralParentById = new Map<string, string | null>();
	structuralParentById.set(VIRTUAL_ROOT_ID, null);
	for (const id of analysis.structural) {
		if (id === VIRTUAL_ROOT_ID) continue;
		const parent = nearestStructuralAncestor(id, analysis.parentById, analysis.structural) ?? VIRTUAL_ROOT_ID;
		structuralParentById.set(id, parent);
	}

	const edges: MapEdge[] = [];
	for (const id of analysis.structural) {
		if (id === VIRTUAL_ROOT_ID) continue;
		const parentId = structuralParentById.get(id) ?? VIRTUAL_ROOT_ID;
		const segmentEntries = collectSegmentEntries(id, parentId, analysis.parentById, analysis.visibleEntries);
		const agg = initAgg();
		let firstMessageText: string | undefined;
		let firstMessageRole: string | undefined;
		for (const entry of segmentEntries) {
			updateAgg(agg, entry);
			if (!firstMessageText) {
				const details = extractMessageDetails(entry);
				firstMessageText = details.text;
				firstMessageRole = details.role;
			}
		}
		edges.push({
			fromNodeId: parentId,
			toNodeId: id,
			entryCount: agg.entryCount,
			messageCount: agg.messageCount,
			userCount: agg.userCount,
			assistantCount: agg.assistantCount,
			toolCount: agg.toolCount,
			tokenCount: agg.tokenCount || undefined,
			firstMessageText,
			firstMessageRole,
			label: `${agg.messageCount} msg${agg.messageCount === 1 ? "" : "s"}`,
		});
	}

	const incoming = new Map<string, MapEdge>();
	const childNodeIdsByParent = new Map<string, string[]>();
	for (const edge of edges) {
		incoming.set(edge.toNodeId, edge);
		if (!childNodeIdsByParent.has(edge.fromNodeId)) childNodeIdsByParent.set(edge.fromNodeId, []);
		childNodeIdsByParent.get(edge.fromNodeId)!.push(edge.toNodeId);
	}

	const nodes: MapNode[] = [];
	for (const id of analysis.structural) {
		const entry = analysis.visibleEntries.get(id)!;
		const label = snapshot.labelById[id];
		const parentNodeId = id === VIRTUAL_ROOT_ID ? null : (structuralParentById.get(id) ?? null);
		const childNodeIds = childNodeIdsByParent.get(id) || [];
		const nodeMessage = id === VIRTUAL_ROOT_ID ? {} : extractNodeMessage(entry);
		const node: MapNode = {
			nodeId: id,
			anchorEntryId: id,
			parentNodeId,
			childNodeIds,
			isRoot: id === VIRTUAL_ROOT_ID,
			isLeaf: childNodeIds.length === 0,
			isBranchPoint: childNodeIds.length > 1,
			isCurrent: !!currentNodeId && id === currentNodeId,
			isLabeled: !!label,
			title: id === VIRTUAL_ROOT_ID ? "ROOT" : getTitle(entry, label, options.labelMode),
			subtitle: id === VIRTUAL_ROOT_ID ? `${analysis.rawRoots.length} root${analysis.rawRoots.length === 1 ? "" : "s"}` : "",
			messageText: nodeMessage.text,
			messageRole: nodeMessage.role,
			depth: 0,
			x: 0,
			y: 0,
			w: 0,
			h: 0,
		};
		const edge = incoming.get(id);
		if (edge) {
			node.subtitle = summarizeEdge(edge);
		}
		nodes.push(node);
	}

	const strippedNodes = nodes.filter((node) => node.nodeId !== VIRTUAL_ROOT_ID);
	for (const node of strippedNodes) {
		if (node.parentNodeId === VIRTUAL_ROOT_ID) node.parentNodeId = null;
		node.isRoot = node.parentNodeId === null;
	}
	const strippedEdges = edges.filter((edge) => edge.fromNodeId !== VIRTUAL_ROOT_ID && edge.toNodeId !== VIRTUAL_ROOT_ID);
	const rootNodeId =
		strippedNodes.find((node) => node.parentNodeId === null)?.nodeId ||
		(currentNodeId && strippedNodes.some((node) => node.nodeId === currentNodeId) ? currentNodeId : undefined) ||
		strippedNodes[0]?.nodeId ||
		"";

	return {
		nodes: strippedNodes,
		edges: strippedEdges,
		rootNodeId,
		currentNodeId,
	};
}
