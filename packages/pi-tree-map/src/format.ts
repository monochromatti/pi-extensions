import type { LabelMode, MapEdge, RawEntry } from "./model.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

export function shortId(id: string): string {
	return id.slice(0, 8);
}

export function truncate(text: string, max: number): string {
	if (max <= 1) return "…";
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}

export function formatLocalTime(timestamp?: string): string {
	if (!timestamp) return "unknown time";
	const d = new Date(timestamp);
	if (Number.isNaN(d.getTime())) return "unknown time";
	return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function getUserSnippet(entry: RawEntry): string | undefined {
	if (entry.type !== "message" || entry.message?.role !== "user") return undefined;
	const text = (entry.message.content || [])
		.filter((p) => p.type === "text" && typeof p.text === "string")
		.map((p) => p.text || "")
		.join("\n")
		.trim();
	if (!text) return undefined;
	return text.replace(/\s+/g, " ");
}

export function getTitle(entry: RawEntry, label: string | undefined, mode: LabelMode): string {
	switch (mode) {
		case "label":
			return label || shortId(entry.id);
		case "id":
			return shortId(entry.id);
		case "timestamp":
			return formatLocalTime(entry.timestamp);
		case "smart":
		default: {
			if (label) return label;
			const snippet = getUserSnippet(entry);
			if (snippet) return snippet;
			return `${entry.type}:${shortId(entry.id)}`;
		}
	}
}

export function summarizeEdge(edge: Pick<MapEdge, "messageCount" | "tokenCount">): string {
	const msg = `${edge.messageCount} msg${edge.messageCount === 1 ? "" : "s"}`;
	if (!edge.tokenCount) return msg;
	return `${msg} · ${edge.tokenCount} tok`;
}
