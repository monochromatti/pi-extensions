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

export function buildTreeMapModel(snapshot: Snapshot, options: BuildGraphOptions): TreeMapModel {
	if (snapshot.entries.length === 0) {
		const rootNode: MapNode = {
			nodeId: VIRTUAL_ROOT_ID,
			anchorEntryId: VIRTUAL_ROOT_ID,
			parentNodeId: null,
			childNodeIds: [],
			isRoot: true,
			isLeaf: true,
			isBranchPoint: false,
			isCurrent: false,
			isLabeled: false,
			title: "ROOT",
			subtitle: "No session history yet.",
			depth: 0,
			x: 0,
			y: 0,
			w: 0,
			h: 0,
		};
		return { nodes: [rootNode], edges: [], rootNodeId: VIRTUAL_ROOT_ID };
	}

	const analysis = analyzeTreeMapSnapshot(snapshot, options.filterMode);
	if (analysis.entries.length === 0) {
		const rootNode: MapNode = {
			nodeId: VIRTUAL_ROOT_ID,
			anchorEntryId: VIRTUAL_ROOT_ID,
			parentNodeId: null,
			childNodeIds: [],
			isRoot: true,
			isLeaf: true,
			isBranchPoint: false,
			isCurrent: false,
			isLabeled: false,
			title: "ROOT",
			subtitle: "No map relevant history yet.",
			depth: 0,
			x: 0,
			y: 0,
			w: 0,
			h: 0,
		};
		return { nodes: [rootNode], edges: [], rootNodeId: VIRTUAL_ROOT_ID };
	}

	const edges: MapEdge[] = [];
	for (const fromId of analysis.structural) {
		for (const firstChild of analysis.childrenById.get(fromId) || []) {
			let cur: string | undefined = firstChild;
			const agg = initAgg();
			let firstMessageText: string | undefined;
			let firstMessageRole: string | undefined;
			while (cur) {
				const entry = analysis.visibleEntries.get(cur);
				if (entry && cur !== VIRTUAL_ROOT_ID) {
					updateAgg(agg, entry);
					if (!firstMessageText) {
						const details = extractMessageDetails(entry);
						firstMessageText = details.text;
						firstMessageRole = details.role;
					}
				}
				if (analysis.structural.has(cur)) {
					edges.push({
						fromNodeId: fromId,
						toNodeId: cur,
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
					break;
				}
				const children = analysis.childrenById.get(cur) || [];
				cur = children[0];
			}
		}
	}

	const incoming = new Map<string, MapEdge>();
	for (const edge of edges) incoming.set(edge.toNodeId, edge);

	const nodes: MapNode[] = [];
	for (const id of analysis.structural) {
		const entry = analysis.visibleEntries.get(id)!;
		const label = snapshot.labelById[id];
		const parentNodeId = id === VIRTUAL_ROOT_ID ? null : nearestStructuralAncestor(id, analysis.parentById, analysis.structural);
		const childNodeIds = edges.filter((edge) => edge.fromNodeId === id).map((edge) => edge.toNodeId);
		const node: MapNode = {
			nodeId: id,
			anchorEntryId: id,
			parentNodeId,
			childNodeIds,
			isRoot: id === VIRTUAL_ROOT_ID,
			isLeaf: childNodeIds.length === 0,
			isBranchPoint: childNodeIds.length > 1,
			isCurrent: !!analysis.currentLeaf && id === analysis.currentLeaf,
			isLabeled: !!label,
			title: id === VIRTUAL_ROOT_ID ? "ROOT" : getTitle(entry, label, options.labelMode),
			subtitle: id === VIRTUAL_ROOT_ID ? `${analysis.rawRoots.length} root${analysis.rawRoots.length === 1 ? "" : "s"}` : "",
			firstBranchMessage: undefined,
			firstBranchMessageRole: undefined,
			depth: 0,
			x: 0,
			y: 0,
			w: 0,
			h: 0,
		};
		const edge = incoming.get(id);
		if (edge) {
			node.subtitle = summarizeEdge(edge);
			node.firstBranchMessage = edge.firstMessageText;
			node.firstBranchMessageRole = edge.firstMessageRole;
		}
		nodes.push(node);
	}

	let currentNodeId = analysis.currentLeaf;
	while (currentNodeId && !analysis.structural.has(currentNodeId)) {
		currentNodeId = analysis.parentById.get(currentNodeId) || undefined;
	}

	const virtualRoot = nodes.find((node) => node.nodeId === VIRTUAL_ROOT_ID);
	if (virtualRoot && virtualRoot.childNodeIds.length === 1) {
		const realRootId = virtualRoot.childNodeIds[0]!;
		const realRoot = nodes.find((node) => node.nodeId === realRootId);
		if (realRoot) {
			realRoot.parentNodeId = null;
			return {
				nodes: nodes.filter((node) => node.nodeId !== VIRTUAL_ROOT_ID),
				edges: edges.filter((edge) => edge.fromNodeId !== VIRTUAL_ROOT_ID && edge.toNodeId !== VIRTUAL_ROOT_ID),
				rootNodeId: realRootId,
				currentNodeId,
			};
		}
	}

	return {
		nodes,
		edges,
		rootNodeId: VIRTUAL_ROOT_ID,
		currentNodeId,
	};
}
