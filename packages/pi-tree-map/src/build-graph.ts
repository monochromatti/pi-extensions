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

function isMessageLike(entry: RawEntry): boolean {
	if (entry.type === "branch_summary") return true;
	return entry.type === "message";
}

function findAdjacentMessages(entries: RawEntry[], index: number, direction: -1 | 1, limit: number): Array<{ text?: string; role?: string }> {
	const messages: Array<{ text?: string; role?: string }> = [];
	for (let i = index + direction; i >= 0 && i < entries.length && messages.length < limit; i += direction) {
		const entry = entries[i]!;
		if (!isMessageLike(entry)) continue;
		const details = extractNodeMessage(entry);
		if (details.text) messages.push(details);
	}
	return direction === -1 ? messages.reverse() : messages;
}

function collectSegmentEntries(childId: string, parentId: string | null, parentById: Map<string, string | null>, visibleEntries: Map<string, RawEntry>): RawEntry[] {
	const reversed: RawEntry[] = [];
	let cur: string | null = childId;
	while (cur && cur !== parentId) {
		const entry = visibleEntries.get(cur);
		if (entry) reversed.push(entry);
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
	for (const id of analysis.structural) {
		structuralParentById.set(id, nearestStructuralAncestor(id, analysis.parentById, analysis.structural));
	}

	const edges: MapEdge[] = [];
	for (const id of analysis.structural) {
		const parentId = structuralParentById.get(id) ?? null;
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
		if (parentId) {
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
	}

	const incoming = new Map<string, MapEdge>();
	const childNodeIdsByParent = new Map<string, string[]>();
	for (const edge of edges) {
		incoming.set(edge.toNodeId, edge);
		if (!childNodeIdsByParent.has(edge.fromNodeId)) childNodeIdsByParent.set(edge.fromNodeId, []);
		childNodeIdsByParent.get(edge.fromNodeId)!.push(edge.toNodeId);
	}

	const entryIndexById = new Map<string, number>();
	analysis.entries.forEach((entry, index) => entryIndexById.set(entry.id, index));

	const nodes: MapNode[] = [];
	for (const id of analysis.structural) {
		const entry = analysis.visibleEntries.get(id)!;
		const label = snapshot.labelById[id];
		const parentNodeId = structuralParentById.get(id) ?? null;
		const childNodeIds = childNodeIdsByParent.get(id) || [];
		const nodeMessage = extractNodeMessage(entry);
		const entryIndex = entryIndexById.get(id) ?? -1;
		const previousMessages = entryIndex >= 0 ? findAdjacentMessages(analysis.entries, entryIndex, -1, 4) : [];
		const nextMessages = entryIndex >= 0 ? findAdjacentMessages(analysis.entries, entryIndex, 1, 4) : [];
		const previousMessage = previousMessages[previousMessages.length - 1] || {};
		const nextMessage = nextMessages[0] || {};
		const node: MapNode = {
			nodeId: id,
			anchorEntryId: id,
			parentNodeId,
			childNodeIds,
			isLeaf: childNodeIds.length === 0,
			isBranchPoint: childNodeIds.length > 1,
			isCurrent: !!currentNodeId && id === currentNodeId,
			isLabeled: !!label,
			title: getTitle(entry, label, options.labelMode),
			subtitle: "",
			messageText: nodeMessage.text,
			messageRole: nodeMessage.role,
			previousMessageText: previousMessage.text,
			previousMessageRole: previousMessage.role,
			nextMessageText: nextMessage.text,
			nextMessageRole: nextMessage.role,
			previousMessages,
			nextMessages,
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

	const rootNodeId =
		nodes.find((node) => node.parentNodeId === null)?.nodeId ||
		(currentNodeId && nodes.some((node) => node.nodeId === currentNodeId) ? currentNodeId : undefined) ||
		nodes[0]?.nodeId ||
		"";

	return {
		nodes,
		edges,
		rootNodeId,
		currentNodeId,
	};
}
