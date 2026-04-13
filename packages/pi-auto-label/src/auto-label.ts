import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getMapStructuralEntryIds } from "../../pi-tree-map/src/graph-core.js";
import type { RawEntry, Snapshot } from "../../pi-tree-map/src/model.js";
import { createAiLabelGenerator, type AiLabelGeneratorResult } from "./ai-label.js";

const FALLBACK_LABEL = "General followup";
const MAX_CONTEXT_MESSAGES = 8;
const MAX_MESSAGE_CHARS = 240;
const LABEL_CONCURRENCY = 4;
const PENDING_WAIT_MS = 5000;
const PENDING_POLL_MS = 100;

const pendingLabelIds = new Set<string>();

interface LabelAttemptResult {
	status: "labeled" | "skipped-existing" | "skipped-in-flight" | "failed";
	label?: string;
	reason?: string;
}

interface BackfillResult {
	candidates: number;
	labeled: number;
	skippedExisting: number;
	skippedInFlight: number;
	failed: number;
	failureReasons: string[];
}

export interface PersistedLabelCallbacks {
	onLabel: (entryId: string, label: string) => void;
	onStatus: (status: string) => void;
}

export interface PersistedLabelController {
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

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function buildEntryMaps(entries: RawEntry[]): {
	byId: Map<string, RawEntry>;
	parentById: Map<string, string | null>;
} {
	const byId = new Map<string, RawEntry>();
	for (const entry of entries) byId.set(entry.id, entry);

	const parentById = new Map<string, string | null>();
	for (const entry of entries) {
		const parentId = entry.parentId && byId.has(entry.parentId) ? entry.parentId : null;
		parentById.set(entry.id, parentId);
	}

	return { byId, parentById };
}

function pathToRoot(entryId: string, parentById: Map<string, string | null>): string[] {
	const path: string[] = [];
	let current: string | null = entryId;
	while (current) {
		path.push(current);
		current = parentById.get(current) ?? null;
	}
	path.reverse();
	return path;
}

function describeTarget(entry: RawEntry): string {
	if (entry.type === "message") {
		return `${entry.message?.role || "unknown"} message`;
	}
	return `${entry.type} entry`;
}

function buildPrompt(entry: RawEntry, entries: RawEntry[]): string {
	const { byId, parentById } = buildEntryMaps(entries);
	const pathIds = pathToRoot(entry.id, parentById);
	const lines: string[] = [`Target: ${describeTarget(entry)}`];

	for (const id of pathIds) {
		const pathEntry = byId.get(id);
		if (!pathEntry) continue;
		const text = extractMessageText(pathEntry);
		if (!text) continue;
		const role = pathEntry.message?.role || "unknown";
		const prefix = id === entry.id ? `TARGET ${role}` : role;
		lines.push(`${prefix}: ${truncate(text, MAX_MESSAGE_CHARS)}`);
	}

	const recentLines = [lines[0]!, ...lines.slice(-(MAX_CONTEXT_MESSAGES - 1))];
	return [
		"Generate a short persisted label for this session tree node.",
		"Rules:",
		"- Output only the label.",
		"- Use 2 to 5 words.",
		"- Noun phrase style.",
		"- Use Sentence case.",
		"- No punctuation if possible.",
		"- No quotes.",
		"- No explanation.",
		`- If unclear, output exactly: ${FALLBACK_LABEL}`,
		"",
		recentLines.join("\n") || "(no usable text)",
	].join("\n");
}

function buildSnapshot(ctx: ExtensionContext): Snapshot {
	const entries = ctx.sessionManager.getEntries() as Snapshot["entries"];
	const labelById: Record<string, string | undefined> = {};
	for (const entry of entries) {
		labelById[entry.id] = ctx.sessionManager.getLabel(entry.id);
	}
	const sm = ctx.sessionManager as unknown as { getLeafEntry?: () => { id: string } | undefined; getLeafId?: () => string | null };
	const currentLeafId = sm.getLeafEntry?.()?.id ?? sm.getLeafId?.() ?? entries.at(-1)?.id;
	return { entries, currentLeafId: currentLeafId || undefined, labelById };
}

function getMapNodeCandidates(ctx: ExtensionContext): RawEntry[] {
	const snapshot = buildSnapshot(ctx);
	const candidateIds = getMapStructuralEntryIds(snapshot, "all");
	const byId = new Map(snapshot.entries.map((entry) => [entry.id, entry] as const));
	return candidateIds.map((id) => byId.get(id)).filter((entry): entry is RawEntry => !!entry);
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) {
		await new Promise((resolve) => setTimeout(resolve, ms));
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timeout);
			signal.removeEventListener("abort", onAbort);
			reject(new Error("aborted"));
		};
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort);
	});
}

async function waitForPendingLabel(ctx: ExtensionContext, entryId: string, signal?: AbortSignal): Promise<string | undefined> {
	const deadline = Date.now() + PENDING_WAIT_MS;
	while (Date.now() < deadline) {
		const label = ctx.sessionManager.getLabel(entryId);
		if (label) return label;
		if (!pendingLabelIds.has(entryId)) return undefined;
		await delay(PENDING_POLL_MS, signal);
	}
	return ctx.sessionManager.getLabel(entryId) || undefined;
}

async function ensureLabelForEntry(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	entry: RawEntry,
	generatorPromise?: Promise<AiLabelGeneratorResult>,
	signal?: AbortSignal,
): Promise<LabelAttemptResult> {
	const existing = ctx.sessionManager.getLabel(entry.id);
	if (existing) {
		return { status: "skipped-existing", label: existing };
	}

	if (pendingLabelIds.has(entry.id)) {
		const pendingLabel = await waitForPendingLabel(ctx, entry.id, signal);
		if (pendingLabel) return { status: "skipped-existing", label: pendingLabel };
		return { status: "skipped-in-flight" };
	}

	pendingLabelIds.add(entry.id);
	try {
		const afterClaim = ctx.sessionManager.getLabel(entry.id);
		if (afterClaim) {
			return { status: "skipped-existing", label: afterClaim };
		}

		const generatorResult = await (generatorPromise || createAiLabelGenerator(ctx));
		if (!generatorResult.generator) {
			return { status: "failed", reason: generatorResult.reason || "label model unavailable" };
		}

		const prompt = buildPrompt(entry, ctx.sessionManager.getEntries() as RawEntry[]);
		const label = (await generatorResult.generator.generate(prompt, signal)) || FALLBACK_LABEL;

		const afterGenerate = ctx.sessionManager.getLabel(entry.id);
		if (afterGenerate) {
			return { status: "skipped-existing", label: afterGenerate };
		}

		pi.setLabel(entry.id, label);
		return { status: "labeled", label };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		if (reason === "aborted") return { status: "failed", reason };
		return { status: "failed", reason };
	} finally {
		pendingLabelIds.delete(entry.id);
	}
}

export async function autoLabelLatestMapNode(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const candidates = getMapNodeCandidates(ctx);
	const latest = [...candidates].reverse().find((entry) => !ctx.sessionManager.getLabel(entry.id));
	if (!latest) return;
	await ensureLabelForEntry(pi, ctx, latest, undefined, ctx.signal);
}

export async function backfillMapNodeLabels(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<BackfillResult> {
	await ctx.waitForIdle();

	const candidates = getMapNodeCandidates(ctx).filter((entry) => !ctx.sessionManager.getLabel(entry.id));
	const result: BackfillResult = {
		candidates: candidates.length,
		labeled: 0,
		skippedExisting: 0,
		skippedInFlight: 0,
		failed: 0,
		failureReasons: [],
	};

	if (candidates.length === 0) {
		return result;
	}

	const generatorResult = await createAiLabelGenerator(ctx);
	if (!generatorResult.generator) {
		result.failed = candidates.length;
		result.failureReasons.push(generatorResult.reason || "label model unavailable");
		return result;
	}

	let index = 0;
	const worker = async (): Promise<void> => {
		while (index < candidates.length) {
			const currentIndex = index;
			index += 1;
			const entry = candidates[currentIndex];
			if (!entry) return;

			const attempt = await ensureLabelForEntry(pi, ctx, entry, Promise.resolve(generatorResult));
			switch (attempt.status) {
				case "labeled":
					result.labeled += 1;
					break;
				case "skipped-existing":
					result.skippedExisting += 1;
					break;
				case "skipped-in-flight":
					result.skippedInFlight += 1;
					break;
				case "failed":
					result.failed += 1;
					if (attempt.reason && !result.failureReasons.includes(attempt.reason)) {
						result.failureReasons.push(attempt.reason);
					}
					break;
			}
		}
	};

	const workerCount = Math.min(LABEL_CONCURRENCY, candidates.length);
	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	return result;
}

export async function startPersistentLabelsForEntryIds(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	entryIds: string[],
	callbacks: PersistedLabelCallbacks,
): Promise<PersistedLabelController> {
	const abort = new AbortController();
	const entries = ctx.sessionManager.getEntries() as RawEntry[];
	const byId = new Map(entries.map((entry) => [entry.id, entry] as const));
	const targets = [...new Set(entryIds)]
		.map((id) => byId.get(id))
		.filter((entry): entry is RawEntry => !!entry)
		.filter((entry) => !ctx.sessionManager.getLabel(entry.id));

	if (targets.length === 0) {
		callbacks.onStatus("Labels: ready");
		return { cancel: () => abort.abort() };
	}

	const generatorResult = await createAiLabelGenerator(ctx);
	if (!generatorResult.generator) {
		callbacks.onStatus(`Labels: unavailable${generatorResult.reason ? ` (${generatorResult.reason})` : ""}`);
		return { cancel: () => abort.abort() };
	}

	callbacks.onStatus(`Labels: ${generatorResult.generator.modelLabel}`);
	let index = 0;
	const worker = async (): Promise<void> => {
		while (!abort.signal.aborted) {
			const currentIndex = index;
			index += 1;
			if (currentIndex >= targets.length) return;
			const entry = targets[currentIndex];
			if (!entry) return;

			const attempt = await ensureLabelForEntry(pi, ctx, entry, Promise.resolve(generatorResult), abort.signal);
			if (abort.signal.aborted) return;
			if ((attempt.status === "labeled" || attempt.status === "skipped-existing") && attempt.label) {
				callbacks.onLabel(entry.id, attempt.label);
			}
		}
	};

	void Promise.all(Array.from({ length: Math.min(LABEL_CONCURRENCY, targets.length) }, () => worker())).then(() => {
		if (!abort.signal.aborted) callbacks.onStatus(`Labels: ${generatorResult.generator?.modelLabel || "done"} done`);
	});

	return {
		cancel: () => abort.abort(),
	};
}
