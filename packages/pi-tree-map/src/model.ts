export type LabelMode = "smart" | "label" | "id" | "timestamp";
export type FilterMode = "all" | "user-only" | "labeled-only";

export interface RawEntry {
	id: string;
	parentId: string | null;
	type: string;
	timestamp?: string;
	message?: {
		role?: string;
		content?: Array<{ type?: string; text?: string }>;
		usage?: { totalTokens?: number };
	};
	summary?: string;
	fromId?: string;
	usage?: { totalTokens?: number };
}

export interface MapNode {
	nodeId: string;
	anchorEntryId: string;
	parentNodeId: string | null;
	childNodeIds: string[];
	isLeaf: boolean;
	isBranchPoint: boolean;
	isCurrent: boolean;
	isLabeled: boolean;
	title: string;
	subtitle: string;
	messageText?: string;
	messageRole?: string;
	previousMessageText?: string;
	previousMessageRole?: string;
	nextMessageText?: string;
	nextMessageRole?: string;
	previousMessages?: Array<{ text?: string; role?: string }>;
	nextMessages?: Array<{ text?: string; role?: string }>;
	depth: number;
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface MapEdge {
	fromNodeId: string;
	toNodeId: string;
	entryCount: number;
	messageCount: number;
	userCount: number;
	assistantCount: number;
	toolCount: number;
	tokenCount?: number;
	firstMessageText?: string;
	firstMessageRole?: string;
	label: string;
}

export interface TreeMapModel {
	nodes: MapNode[];
	edges: MapEdge[];
	rootNodeId: string;
	currentNodeId?: string;
}

export interface Snapshot {
	entries: RawEntry[];
	currentLeafId?: string;
	labelById: Record<string, string | undefined>;
}

export interface BuildGraphOptions {
	filterMode: FilterMode;
	labelMode: LabelMode;
}
