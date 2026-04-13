import { VIRTUAL_ROOT_ID } from "./constants.js";
import type { FilterMode, RawEntry, Snapshot } from "./model.js";

export const BOOKKEEPING_ENTRY_TYPES = new Set([
	"label",
	"custom",
	"model_change",
	"thinking_level_change",
	"session_info",
]);

export function isMapRelevantEntry(entry: RawEntry): boolean {
	return !BOOKKEEPING_ENTRY_TYPES.has(entry.type);
}

function nearestRelevantSelfOrAncestor(
	id: string,
	parentRaw: Map<string, string | null>,
	relevant: Set<string>,
): string | null {
	let cur: string | null = id;
	while (cur && !relevant.has(cur)) {
		cur = parentRaw.get(cur) ?? null;
	}
	return cur;
}

function nearestRelevantAncestor(
	id: string,
	parentRaw: Map<string, string | null>,
	relevant: Set<string>,
): string | null {
	const parent = parentRaw.get(id) ?? null;
	return parent ? nearestRelevantSelfOrAncestor(parent, parentRaw, relevant) : null;
}

function nearestVisibleAncestor(id: string, parentRaw: Map<string, string | null>, visible: Set<string>): string | null {
	let parent = parentRaw.get(id) ?? null;
	while (parent && !visible.has(parent)) {
		parent = parentRaw.get(parent) ?? null;
	}
	return parent;
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

export interface TreeMapGraphAnalysis {
	allEntries: RawEntry[];
	entries: RawEntry[];
	rawById: Map<string, RawEntry>;
	rawParentById: Map<string, string | null>;
	relevantIds: Set<string>;
	byId: Map<string, RawEntry>;
	parentRaw: Map<string, string | null>;
	childrenRaw: Map<string, string[]>;
	rawRoots: string[];
	currentLeaf?: string;
	visible: Set<string>;
	parentById: Map<string, string | null>;
	childrenById: Map<string, string[]>;
	visibleEntries: Map<string, RawEntry>;
	structural: Set<string>;
}

export function analyzeTreeMapSnapshot(snapshot: Snapshot, filterMode: FilterMode): TreeMapGraphAnalysis {
	const allEntries = snapshot.entries;
	const rawById = new Map<string, RawEntry>();
	const rawParentById = new Map<string, string | null>();
	for (const entry of allEntries) {
		rawById.set(entry.id, entry);
	}
	for (const entry of allEntries) {
		const parent = entry.parentId && rawById.has(entry.parentId) ? entry.parentId : null;
		rawParentById.set(entry.id, parent);
	}

	const entries = allEntries.filter((entry) => isMapRelevantEntry(entry));
	const relevantIds = new Set(entries.map((entry) => entry.id));
	const byId = new Map<string, RawEntry>();
	const parentRaw = new Map<string, string | null>();
	const childrenRaw = new Map<string, string[]>();
	for (const entry of entries) {
		byId.set(entry.id, entry);
		childrenRaw.set(entry.id, []);
	}

	for (const entry of entries) {
		const parent = nearestRelevantAncestor(entry.id, rawParentById, relevantIds);
		parentRaw.set(entry.id, parent);
		if (parent) childrenRaw.get(parent)?.push(entry.id);
	}

	const rawRoots = entries.filter((entry) => !parentRaw.get(entry.id)).map((entry) => entry.id);
	const currentLeaf = snapshot.currentLeafId
		? nearestRelevantSelfOrAncestor(snapshot.currentLeafId, rawParentById, relevantIds) || undefined
		: undefined;

	const visible = new Set<string>();
	for (const root of rawRoots) visible.add(root);
	if (currentLeaf) visible.add(currentLeaf);

	if (filterMode === "all") {
		for (const entry of entries) visible.add(entry.id);
	} else if (filterMode === "user-only") {
		for (const entry of entries) {
			if (entry.type === "message" && entry.message?.role === "user") visible.add(entry.id);
		}
	} else {
		const labeledIds = entries.filter((entry) => !!snapshot.labelById[entry.id]).map((entry) => entry.id);
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
		const parent = nearestVisibleAncestor(id, parentRaw, visible) ?? VIRTUAL_ROOT_ID;
		parentById.set(id, parent);
		if (!childrenById.has(parent)) childrenById.set(parent, []);
		childrenById.get(parent)?.push(id);
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
		const entry = byId.get(id);
		if (entry) visibleEntries.set(id, entry);
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

	const realStructuralNodeIds = [...structural].filter((id) => id !== VIRTUAL_ROOT_ID);
	if (rawRoots.length === 1 && currentLeaf && currentLeaf !== rawRoots[0] && realStructuralNodeIds.length === 1) {
		structural.add(rawRoots[0]!);
	}

	return {
		allEntries,
		entries,
		rawById,
		rawParentById,
		relevantIds,
		byId,
		parentRaw,
		childrenRaw,
		rawRoots,
		currentLeaf,
		visible,
		parentById,
		childrenById,
		visibleEntries,
		structural,
	};
}

export function getMapStructuralEntryIds(snapshot: Snapshot, filterMode: FilterMode = "all"): string[] {
	if (snapshot.entries.length === 0) return [];
	const analysis = analyzeTreeMapSnapshot(snapshot, filterMode);
	if (analysis.entries.length === 0) return [];
	return analysis.entries.map((entry) => entry.id).filter((id) => analysis.structural.has(id));
}
