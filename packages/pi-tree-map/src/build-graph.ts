import { VIRTUAL_ROOT_ID } from "./constants.js";
import { getTitle, summarizeEdge } from "./format.js";
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

function nearestVisibleAncestor(id: string, parentRaw: Map<string, string | null>, visible: Set<string>): string | null {
	let p = parentRaw.get(id) ?? null;
	while (p && !visible.has(p)) {
		p = parentRaw.get(p) ?? null;
	}
	return p;
}

function nearestStructuralAncestor(id: string, parentById: Map<string, string | null>, structural: Set<string>): string | null {
	let p = parentById.get(id) ?? null;
	while (p && !structural.has(p)) {
		p = parentById.get(p) ?? null;
	}
	return p;
}

function collectAncestors(seedIds: Iterable<string>, parentRaw: Map<string, string | null>): Set<string> {
	const keep = new Set<string>();
	for (const id of seedIds) {
		let cur: string | null = id;
		while (cur) {
			if (keep.has(cur)) break;
			keep.add(cur);
			cur = parentRaw.get(cur) ?? null;
		}
	}
	return keep;
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
	const entries = snapshot.entries;
	if (entries.length === 0) {
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

	const byId = new Map<string, RawEntry>();
	const parentRaw = new Map<string, string | null>();
	const childrenRaw = new Map<string, string[]>();
	for (const e of entries) {
		byId.set(e.id, e);
		childrenRaw.set(e.id, []);
	}

	for (const e of entries) {
		const parent = e.parentId && byId.has(e.parentId) ? e.parentId : null;
		parentRaw.set(e.id, parent);
		if (parent) {
			childrenRaw.get(parent)!.push(e.id);
		}
	}

	const rawRoots = entries.filter((e) => !parentRaw.get(e.id)).map((e) => e.id);
	const currentLeaf = snapshot.currentLeafId && byId.has(snapshot.currentLeafId) ? snapshot.currentLeafId : undefined;

	const visible = new Set<string>();
	for (const root of rawRoots) visible.add(root);
	if (currentLeaf) visible.add(currentLeaf);

	if (options.filterMode === "all") {
		for (const e of entries) visible.add(e.id);
	} else if (options.filterMode === "user-only") {
		for (const e of entries) {
			if (e.type === "message" && e.message?.role === "user") visible.add(e.id);
		}
	} else {
		const labeledIds = entries.filter((e) => !!snapshot.labelById[e.id]).map((e) => e.id);
		const keep = collectAncestors(labeledIds, parentRaw);
		for (const id of keep) visible.add(id);
	}

	const parentById = new Map<string, string | null>();
	const childrenById = new Map<string, string[]>();
	childrenById.set(VIRTUAL_ROOT_ID, []);

	for (const id of visible) {
		if (id === VIRTUAL_ROOT_ID) continue;
		childrenById.set(id, []);
	}

	for (const id of visible) {
		if (id === VIRTUAL_ROOT_ID) continue;
		const p = nearestVisibleAncestor(id, parentRaw, visible);
		const parent = p ?? VIRTUAL_ROOT_ID;
		parentById.set(id, parent);
		if (!childrenById.has(parent)) childrenById.set(parent, []);
		childrenById.get(parent)!.push(id);
	}
	parentById.set(VIRTUAL_ROOT_ID, null);

	const visibleEntries = new Map<string, RawEntry>();
	visibleEntries.set(VIRTUAL_ROOT_ID, {
		id: VIRTUAL_ROOT_ID,
		parentId: null,
		type: "root",
		timestamp: new Date().toISOString(),
	});
	for (const id of visible) {
		const e = byId.get(id);
		if (e) visibleEntries.set(id, e);
	}

	const structural = new Set<string>();
	for (const [id] of visibleEntries) {
		const childCount = (childrenById.get(id) || []).length;
		const isRoot = id === VIRTUAL_ROOT_ID;
		const isLeaf = childCount === 0;
		const isBranch = childCount > 1;
		if (isRoot || isLeaf || isBranch || (currentLeaf && id === currentLeaf)) {
			structural.add(id);
		}
	}

	const edges: MapEdge[] = [];
	for (const fromId of structural) {
		for (const firstChild of childrenById.get(fromId) || []) {
			let cur: string | undefined = firstChild;
			const agg = initAgg();
			let firstMessageText: string | undefined;
			let firstMessageRole: string | undefined;
			while (cur) {
				const e = visibleEntries.get(cur);
				if (e && cur !== VIRTUAL_ROOT_ID) {
					updateAgg(agg, e);
					if (!firstMessageText) {
						const details = extractMessageDetails(e);
						firstMessageText = details.text;
						firstMessageRole = details.role;
					}
				}
				if (structural.has(cur)) {
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
				const children = childrenById.get(cur) || [];
				cur = children[0];
			}
		}
	}

	const incoming = new Map<string, MapEdge>();
	for (const e of edges) incoming.set(e.toNodeId, e);

	const nodes: MapNode[] = [];
	for (const id of structural) {
		const entry = visibleEntries.get(id)!;
		const label = snapshot.labelById[id];
		const parentNodeId = id === VIRTUAL_ROOT_ID ? null : nearestStructuralAncestor(id, parentById, structural);
		const childNodeIds = edges.filter((e) => e.fromNodeId === id).map((e) => e.toNodeId);
		const node: MapNode = {
			nodeId: id,
			anchorEntryId: id,
			parentNodeId,
			childNodeIds,
			isRoot: id === VIRTUAL_ROOT_ID,
			isLeaf: childNodeIds.length === 0,
			isBranchPoint: childNodeIds.length > 1,
			isCurrent: !!currentLeaf && id === currentLeaf,
			isLabeled: !!label,
			title: id === VIRTUAL_ROOT_ID ? "ROOT" : getTitle(entry, label, options.labelMode),
			subtitle: id === VIRTUAL_ROOT_ID ? `${rawRoots.length} root${rawRoots.length === 1 ? "" : "s"}` : "",
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

	let currentNodeId = currentLeaf;
	while (currentNodeId && !structural.has(currentNodeId)) {
		currentNodeId = parentById.get(currentNodeId) || undefined;
	}

	return {
		nodes,
		edges,
		rootNodeId: VIRTUAL_ROOT_ID,
		currentNodeId,
	};
}
