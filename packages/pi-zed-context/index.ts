import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const extensionDir = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_MAX_TEXT_CHARS = 20_000;
const HARD_MAX_TEXT_CHARS = 200_000;
const SQLITE_MAX_BUFFER_BYTES = 50 * 1024 * 1024;

const TOOL_PARAMS = Type.Object({
	maxTextChars: Type.Optional(
		Type.Number({
			description: "Maximum selected text characters to return across all selections. Default 20000.",
			minimum: 0,
		}),
	),
	allowUnmatchedWorkspace: Type.Optional(
		Type.Boolean({
			description: "Fall back to most recently active Zed editor when no editor workspace matches Pi cwd.",
		}),
	),
});

type ZedContextParams = {
	maxTextChars?: number;
	allowUnmatchedWorkspace?: boolean;
};

type RawZedRow = {
	editor_id: number;
	workspace_id: number;
	workspace_paths: string | null;
	timestamp: string | null;
	buffer_path: string | null;
	contents: string | null;
	selection_start: number | null;
	selection_end: number | null;
};

type EditorCandidate = {
	key: string;
	row: RawZedRow & { buffer_path: string };
	workspacePaths: string[];
	workspaceScore: number;
	selectionRows: RawZedRow[];
};

type Position = {
	line: number;
	character: number;
};

type ZedSelection = {
	isEmpty: boolean;
	lineStart: number;
	lineEnd: number;
	start: Position;
	end: Position;
	selectedText: string;
	selectedTextTruncated: boolean;
};

type ZedContext = {
	dbPath: string;
	cwd: string;
	workspaceMatched: boolean;
	workspaceScore: number;
	workspacePaths: string[];
	filePath: string;
	selection: ZedSelection;
	selections: ZedSelection[];
};

type ZedContextResult =
	| { ok: true; context: ZedContext }
	| { ok: false; error: string; details?: unknown };

const ZED_ACTIVE_EDITORS_QUERY = `
select
  e.item_id as editor_id,
  e.workspace_id as workspace_id,
  w.paths as workspace_paths,
  w.timestamp as timestamp,
  e.buffer_path as buffer_path,
  e.contents as contents,
  s.start as selection_start,
  s.end as selection_end
from items i
join panes p on p.pane_id = i.pane_id and p.workspace_id = i.workspace_id
join workspaces w on w.workspace_id = i.workspace_id
join editors e on e.item_id = i.item_id and e.workspace_id = i.workspace_id
left join editor_selections s on s.editor_id = e.item_id and s.workspace_id = e.workspace_id
where i.active = 1 and p.active = 1 and i.kind = 'Editor' and e.buffer_path is not null
order by w.timestamp desc;
`;

export default function zedContextExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "zed_context",
		label: "Zed Context",
		description: "Get active file, cursor, and selected line ranges from the local Zed editor state DB.",
		promptSnippet: "Get active Zed file and selected lines from the local Zed editor state DB",
		promptGuidelines: [
			"Use zed_context when the user refers to the currently open file, active Zed tab, cursor, or selected lines in Zed.",
			"Use zed_context before answering questions like 'this selection', 'the selected code', 'current file', or 'what I have open in Zed'.",
		],
		parameters: TOOL_PARAMS,
		async execute(_toolCallId, params: ZedContextParams, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Reading Zed active editor state..." }] });
			const result = await readZedContext(ctx.cwd, params, signal);
			if (!result.ok) throw new Error(result.error);

			return {
				content: [{ type: "text", text: formatZedContext(result.context) }],
				details: result.context,
			};
		},
	});

	pi.on("resources_discover", () => ({
		skillPaths: [path.join(extensionDir, "skills")],
	}));

	pi.registerCommand("zed-context", {
		description: "Show active file and selected lines from Zed",
		handler: async (_args, ctx) => {
			const result = await readZedContext(ctx.cwd, {}, ctx.signal);
			ctx.ui.notify(result.ok ? formatZedContext(result.context) : result.error, result.ok ? "info" : "error");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus("zed-context", "Zed context tool ready");
	});
}

async function readZedContext(cwd: string, params: ZedContextParams, signal?: AbortSignal): Promise<ZedContextResult> {
	const dbPath = resolveZedDbPath();
	if (!dbPath) {
		return {
			ok: false,
			error: "Zed DB not found. Open Zed once, or set PI_ZED_CONTEXT_DB=/path/to/db.sqlite.",
		};
	}

	const rowsResult = await readActiveEditorRows(dbPath, signal);
	if (!rowsResult.ok) return rowsResult;

	const candidates = buildCandidates(rowsResult.rows, cwd);
	const candidate = pickCandidate(candidates, params.allowUnmatchedWorkspace === true);
	if (!candidate) {
		return {
			ok: false,
			error:
				candidates.length === 0
					? "No active Zed editor found."
					: `No active Zed editor matched Pi cwd: ${cwd}. Pass allowUnmatchedWorkspace=true to use most recent active editor.`,
			details: { dbPath, cwd, candidateCount: candidates.length },
		};
	}

	const text = candidate.row.contents ?? readFileIfPossible(candidate.row.buffer_path);
	if (text == null) {
		return {
			ok: false,
			error: `Could not read active Zed buffer or file: ${candidate.row.buffer_path}`,
			details: { dbPath, filePath: candidate.row.buffer_path },
		};
	}

	const selections = buildSelections(text, candidate.selectionRows, normalizeMaxTextChars(params.maxTextChars));
	return {
		ok: true,
		context: {
			dbPath,
			cwd,
			workspaceMatched: candidate.workspaceScore > 0,
			workspaceScore: candidate.workspaceScore,
			workspacePaths: candidate.workspacePaths,
			filePath: candidate.row.buffer_path,
			selection: selections[0],
			selections,
		},
	};
}

async function readActiveEditorRows(
	dbPath: string,
	signal?: AbortSignal,
): Promise<{ ok: true; rows: RawZedRow[] } | { ok: false; error: string; details?: unknown }> {
	try {
		const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", dbPath, ZED_ACTIVE_EDITORS_QUERY], {
			encoding: "utf8",
			maxBuffer: SQLITE_MAX_BUFFER_BYTES,
			signal,
		});

		const parsed = JSON.parse(stdout || "[]") as unknown;
		return { ok: true, rows: Array.isArray(parsed) ? parsed.filter(isRawZedRow) : [] };
	} catch (error) {
		return {
			ok: false,
			error: `Failed querying Zed DB via sqlite3: ${error instanceof Error ? error.message : String(error)}`,
			details: { dbPath },
		};
	}
}

function buildCandidates(rows: RawZedRow[], cwd: string): EditorCandidate[] {
	const candidates = new Map<string, EditorCandidate>();

	for (const row of rows) {
		if (!row.buffer_path) continue;

		const key = `${row.workspace_id}:${row.editor_id}`;
		const existing = candidates.get(key);
		if (existing) {
			existing.selectionRows.push(row);
			continue;
		}

		const workspacePaths = parseWorkspacePaths(row.workspace_paths);
		candidates.set(key, {
			key,
			row: { ...row, buffer_path: row.buffer_path },
			workspacePaths,
			workspaceScore: scoreWorkspace(workspacePaths, cwd),
			selectionRows: [row],
		});
	}

	return [...candidates.values()].sort(
		(left, right) =>
			right.workspaceScore - left.workspaceScore ||
			String(right.row.timestamp ?? "").localeCompare(String(left.row.timestamp ?? "")) ||
			left.key.localeCompare(right.key),
	);
}

function pickCandidate(candidates: EditorCandidate[], allowUnmatchedWorkspace: boolean): EditorCandidate | undefined {
	return candidates.find((candidate) => candidate.workspaceScore > 0) ?? (allowUnmatchedWorkspace ? candidates[0] : undefined);
}

function buildSelections(text: string, rows: RawZedRow[], maxTextChars: number): ZedSelection[] {
	const selectionRows = rows
		.filter(hasSelectionOffsets)
		.sort((left, right) => selectionStartOffset(left) - selectionStartOffset(right));

	let remainingTextChars = maxTextChars;
	const sourceRows = selectionRows.length > 0 ? selectionRows : [{ selection_start: 0, selection_end: 0 }];

	return sourceRows.map((row) => {
		const selection = buildSelection(text, row.selection_start ?? 0, row.selection_end ?? row.selection_start ?? 0, remainingTextChars);
		remainingTextChars = Math.max(0, remainingTextChars - selection.selectedText.length);
		return selection;
	});
}

function buildSelection(text: string, rawStart: number, rawEnd: number, maxTextChars: number): ZedSelection {
	const startOffset = clamp(Math.min(rawStart, rawEnd), 0, text.length);
	const endOffset = clamp(Math.max(rawStart, rawEnd), 0, text.length);
	const start = offsetToPosition(text, startOffset);
	const end = offsetToPosition(text, endOffset);
	const isEmpty = startOffset === endOffset;
	const rawSelectedText = text.slice(startOffset, endOffset);
	const selectedText = rawSelectedText.slice(0, maxTextChars);
	const lineEnd = !isEmpty && end.character === 1 && rawSelectedText.endsWith("\n") ? Math.max(start.line, end.line - 1) : end.line;

	return {
		isEmpty,
		lineStart: start.line,
		lineEnd,
		start,
		end,
		selectedText,
		selectedTextTruncated: selectedText.length < rawSelectedText.length,
	};
}

function isRawZedRow(value: unknown): value is RawZedRow {
	if (!value || typeof value !== "object") return false;
	const row = value as Partial<RawZedRow>;
	return typeof row.editor_id === "number" && typeof row.workspace_id === "number";
}

function hasSelectionOffsets(row: RawZedRow): row is RawZedRow & { selection_start: number; selection_end: number } {
	return row.selection_start != null && row.selection_end != null;
}

function selectionStartOffset(row: { selection_start: number; selection_end: number }): number {
	return Math.min(row.selection_start, row.selection_end);
}

function resolveZedDbPath(): string | undefined {
	const home = os.homedir();
	const candidates = [
		process.env.PI_ZED_CONTEXT_DB,
		process.env.OPENCODE_ZED_DB,
		path.join(home, "Library", "Application Support", "Zed", "db", "0-stable", "db.sqlite"),
		path.join(home, "Library", "Application Support", "Zed", "db", "0-preview", "db.sqlite"),
		path.join(home, "Library", "Application Support", "Zed", "db", "0-dev", "db.sqlite"),
		path.join(home, ".local", "share", "zed", "db", "0-stable", "db.sqlite"),
		path.join(home, ".local", "share", "zed", "db", "0-preview", "db.sqlite"),
		path.join(home, ".local", "share", "zed", "db", "0-dev", "db.sqlite"),
	].filter((candidate): candidate is string => Boolean(candidate));

	return candidates.find((candidate) => existsSync(candidate));
}

function parseWorkspacePaths(value: string | null): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string");
	} catch {
		// Older DBs may store newline-separated paths.
	}
	return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function scoreWorkspace(workspacePaths: string[], cwd: string): number {
	return workspacePaths.reduce((score, workspacePath) => {
		if (pathContains(workspacePath, cwd)) return Math.max(score, 2);
		if (pathContains(cwd, workspacePath)) return Math.max(score, 1);
		return score;
	}, 0);
}

function pathContains(parent: string, child: string): boolean {
	const relative = path.relative(path.resolve(parent), path.resolve(child));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readFileIfPossible(filePath: string): string | null {
	try {
		return readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
}

function offsetToPosition(text: string, targetOffset: number): Position {
	const offset = clamp(targetOffset, 0, text.length);
	let line = 1;
	let lineStart = 0;

	for (let index = 0; index < offset; index++) {
		if (text[index] === "\n") {
			line += 1;
			lineStart = index + 1;
		}
	}

	return { line, character: offset - lineStart + 1 };
}

function normalizeMaxTextChars(value: number | undefined): number {
	return clamp(Math.floor(value ?? DEFAULT_MAX_TEXT_CHARS), 0, HARD_MAX_TEXT_CHARS);
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function formatZedContext(context: ZedContext): string {
	const displayPath = pathInside(context.cwd, context.filePath) ?? context.filePath;
	const selectionSummary =
		context.selections.length === 1
			? formatSelectionSummary(context.selections[0])
			: `${context.selections.length} selections: ${context.selections.map(formatSelectionSummary).join(", ")}`;
	const selectedText = context.selections
		.map((selection, index) => formatSelectedText(selection, index, context.selections.length))
		.filter((item): item is string => Boolean(item))
		.join("\n\n");

	return [
		`Zed active file: ${displayPath}`,
		`Full path: ${context.filePath}`,
		selectionSummary,
		selectedText,
	]
		.filter(Boolean)
		.join("\n");
}

function formatSelectedText(selection: ZedSelection, index: number, selectionCount: number): string | undefined {
	if (!selection.selectedText) return undefined;
	const label = selectionCount === 1 ? "Selected text" : `Selected text ${index + 1}`;
	return `\n${label}${selection.selectedTextTruncated ? " (truncated)" : ""}:\n${selection.selectedText}`;
}

function formatSelectionSummary(selection: ZedSelection): string {
	if (selection.isEmpty) return `cursor ${selection.start.line}:${selection.start.character}`;
	if (selection.lineStart === selection.lineEnd) return `selected line ${selection.lineStart}`;
	return `selected lines ${selection.lineStart}-${selection.lineEnd}`;
}

function pathInside(parent: string, child: string): string | undefined {
	const relative = path.relative(path.resolve(parent), path.resolve(child));
	return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : undefined;
}
