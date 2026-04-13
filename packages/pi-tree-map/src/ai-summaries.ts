import { completeSimple, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { truncate } from "./format.js";
import type { RawEntry, Snapshot, TreeMapModel } from "./model.js";

const SUMMARY_PROVIDER = "anthropic";
const SUMMARY_MODEL_ID = "claude-haiku-4-5";
const MAX_TITLE_CHARS = 160;
const MAX_CONTEXT_MESSAGES = 8;
const CONCURRENCY = 8;

export interface AiSummaryCallbacks {
	onTitle: (nodeId: string, title: string) => void;
	onStatus: (status: string) => void;
}

export interface AiSummaryController {
	cancel: () => void;
}

function extractMessageText(entry: RawEntry): string | undefined {
	if (entry.type !== "message") return undefined;
	const text = (entry.message?.content || [])
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text || "")
		.join("\n")
		.trim();
	if (!text) return undefined;
	return text.replace(/\s+/g, " ");
}

function buildEntryMaps(entries: RawEntry[]): {
	byId: Map<string, RawEntry>;
	parentById: Map<string, string | null>;
} {
	const byId = new Map<string, RawEntry>();
	for (const e of entries) byId.set(e.id, e);

	const parentById = new Map<string, string | null>();
	for (const e of entries) {
		const parent = e.parentId && byId.has(e.parentId) ? e.parentId : null;
		parentById.set(e.id, parent);
	}
	return { byId, parentById };
}

function pathToRoot(entryId: string, parentById: Map<string, string | null>): string[] {
	const path: string[] = [];
	let cur: string | null = entryId;
	while (cur) {
		path.push(cur);
		cur = parentById.get(cur) ?? null;
	}
	path.reverse();
	return path;
}

function buildPrompt(nodeId: string, snapshot: Snapshot): string {
	const { byId, parentById } = buildEntryMaps(snapshot.entries);
	const pathIds = pathToRoot(nodeId, parentById);
	const msgLines: string[] = [];

	for (const id of pathIds) {
		const entry = byId.get(id);
		if (!entry) continue;
		const text = extractMessageText(entry);
		if (!text) continue;
		const role = entry.message?.role || "unknown";
		msgLines.push(`${role}: ${truncate(text, 240)}`);
	}

	const compact = msgLines.slice(-MAX_CONTEXT_MESSAGES).join("\n");
	return [
		"Generate a branch label from this conversation path.",
		"Rules:",
		"- Output 2 to 5 words.",
		"- Noun phrase style.",
		"- No punctuation, no quotes.",
		"- No reasoning or explanation.",
		"- If unclear, output: General followup",
		"",
		compact || "(no text messages on this path)",
	].join("\n");
}

function pickSummaryText(response: Awaited<ReturnType<typeof completeSimple>>): string | undefined {
	if (response.stopReason === "aborted" || response.stopReason === "error") return undefined;
	const text = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	if (!text) return undefined;
	const normalized = text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ");
	return normalized.length <= MAX_TITLE_CHARS ? normalized : normalized.slice(0, MAX_TITLE_CHARS);
}

export async function startAiSummaries(
	ctx: ExtensionCommandContext,
	model: TreeMapModel,
	snapshot: Snapshot,
	callbacks: AiSummaryCallbacks,
): Promise<AiSummaryController> {
	const abort = new AbortController();
	const nodes = model.nodes.filter((n) => !n.isRoot);
	if (nodes.length === 0) {
		callbacks.onStatus("AI: no nodes");
		return { cancel: () => abort.abort() };
	}

	const registry = ctx.modelRegistry as unknown as {
		getAvailable?: () => unknown[] | Promise<unknown[]>;
		getApiKeyAndHeaders?: (
			model: unknown,
		) => Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
	};

	const available = await Promise.resolve(registry.getAvailable?.() || []);
	const summaryModel = (available as Array<{ provider?: string; id?: string }>).find(
		(m) => m.provider === SUMMARY_PROVIDER && m.id === SUMMARY_MODEL_ID,
	);
	if (!summaryModel || !registry.getApiKeyAndHeaders) {
		callbacks.onStatus(`AI: model ${SUMMARY_MODEL_ID} unavailable`);
		return { cancel: () => abort.abort() };
	}

	const auth = await registry.getApiKeyAndHeaders(summaryModel);
	if (!auth.ok || !auth.apiKey) {
		callbacks.onStatus(`AI: auth unavailable${auth.error ? ` (${auth.error})` : ""}`);
		return { cancel: () => abort.abort() };
	}

	callbacks.onStatus(`AI: ${SUMMARY_MODEL_ID}`);

	let index = 0;
	const worker = async (): Promise<void> => {
		while (!abort.signal.aborted) {
			const i = index;
			index += 1;
			if (i >= nodes.length) return;
			const node = nodes[i]!;
			if (node.isLabeled) continue;

			try {
				const prompt = buildPrompt(node.anchorEntryId, snapshot);
				const msg: UserMessage = {
					role: "user",
					content: [{ type: "text", text: prompt }],
					timestamp: Date.now(),
				};
				const response = await completeSimple(summaryModel as never, { messages: [msg] }, {
					apiKey: auth.apiKey,
					headers: auth.headers,
					signal: abort.signal,
					reasoning: "minimal",
					maxTokens: 24,
					temperature: 0.2,
				});
				if (abort.signal.aborted) return;
				const text = pickSummaryText(response);
				if (text) callbacks.onTitle(node.nodeId, text);
			} catch {
				// best effort; continue
			}
		}
	};

	void Promise.all(Array.from({ length: Math.min(CONCURRENCY, nodes.length) }, () => worker())).then(() => {
		if (!abort.signal.aborted) callbacks.onStatus(`AI: ${SUMMARY_MODEL_ID} done`);
	});

	return {
		cancel: () => abort.abort(),
	};
}
