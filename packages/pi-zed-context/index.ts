import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@mariozechner/pi-tui";
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
const MAX_AUTOCOMPLETE_ITEMS = 30;

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
	pane_id?: number | null;
	pane_active?: number | null;
	position?: number | null;
	tab_active?: number | null;
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

type ZedEditorRef = {
	ref: string;
	fileRef: string;
	dbPath: string;
	cwd: string;
	workspaceMatched: boolean;
	workspaceScore: number;
	workspacePaths: string[];
	filePath: string;
	displayPath: string;
	contents: string;
	contentsTruncated: boolean;
	active: boolean;
	paneActive: boolean;
	selections: ZedSelection[];
};

type ZedEditorsResult =
	| { ok: true; editors: ZedEditorRef[] }
	| { ok: false; error: string; details?: unknown };

const ZED_ACTIVE_EDITORS_QUERY = `
select
  e.item_id as editor_id,
  e.workspace_id as workspace_id,
  w.paths as workspace_paths,
  w.timestamp as timestamp,
  i.pane_id as pane_id,
  p.active as pane_active,
  i.position as position,
  i.active as tab_active,
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

const ZED_OPEN_EDITORS_QUERY = `
select
  e.item_id as editor_id,
  e.workspace_id as workspace_id,
  w.paths as workspace_paths,
  w.timestamp as timestamp,
  i.pane_id as pane_id,
  p.active as pane_active,
  i.position as position,
  i.active as tab_active,
  e.buffer_path as buffer_path,
  e.contents as contents,
  s.start as selection_start,
  s.end as selection_end
from items i
join panes p on p.pane_id = i.pane_id and p.workspace_id = i.workspace_id
join workspaces w on w.workspace_id = i.workspace_id
join editors e on e.item_id = i.item_id and e.workspace_id = i.workspace_id
left join editor_selections s on s.editor_id = e.item_id and s.workspace_id = e.workspace_id
where i.kind = 'Editor' and e.buffer_path is not null
order by w.timestamp desc, p.active desc, i.active desc, i.position asc;
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
			onUpdate?.({ content: [{ type: "text", text: "Reading Zed active editor state..." }], details: undefined });
			const result = await readZedContext(ctx.cwd, params, signal);
			if (result.ok === false) throw new Error(result.error);

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
		ctx.ui.addAutocompleteProvider((current) => createZedAutocompleteProvider(current, () => readZedEditors(ctx.cwd, { allowUnmatchedWorkspace: true }, ctx.signal)));
	});

	pi.on("input", async (event, ctx) => {
		if (!event.text.includes("@zed:")) return { action: "continue" };
		const result = await readZedEditors(ctx.cwd, { allowUnmatchedWorkspace: true }, ctx.signal);
		if (result.ok === false) return { action: "continue" };
		const expanded = expandZedReferences(event.text, result.editors);
		return expanded === event.text ? { action: "continue" } : { action: "transform", text: expanded, images: event.images };
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
	if (rowsResult.ok === false) return rowsResult;

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

async function readZedEditors(cwd: string, params: ZedContextParams, signal?: AbortSignal): Promise<ZedEditorsResult> {
	const dbPath = resolveZedDbPath();
	if (!dbPath) {
		return { ok: false, error: "Zed DB not found. Open Zed once, or set PI_ZED_CONTEXT_DB=/path/to/db.sqlite." };
	}

	const rowsResult = await readEditorRows(dbPath, ZED_OPEN_EDITORS_QUERY, signal);
	if (rowsResult.ok === false) return rowsResult;

	const candidates = buildCandidates(rowsResult.rows, cwd).filter(
		(candidate) => candidate.workspaceScore > 0 || params.allowUnmatchedWorkspace === true,
	);
	const recentCandidates = [...candidates].sort(compareCandidatesByRecency);
	const maxTextChars = normalizeMaxTextChars(params.maxTextChars);

	return {
		ok: true,
		editors: recentCandidates.map((candidate, index) => {
			const rawText = candidate.row.contents ?? readFileIfPossible(candidate.row.buffer_path) ?? "";
			const text = rawText.slice(0, maxTextChars);
			const selections = buildSelections(rawText, candidate.selectionRows, maxTextChars);
			const displayPath = pathInside(cwd, candidate.row.buffer_path) ?? candidate.row.buffer_path;
			const fileRef = `@zed:file:${encodeZedRef(candidate.row.buffer_path)}`;
			return {
				ref: `@zed:${index}`,
				fileRef,
				dbPath,
				cwd,
				workspaceMatched: candidate.workspaceScore > 0,
				workspaceScore: candidate.workspaceScore,
				workspacePaths: candidate.workspacePaths,
				filePath: candidate.row.buffer_path,
				displayPath,
				contents: text,
				contentsTruncated: text.length < rawText.length,
				active: candidate.row.tab_active === 1,
				paneActive: candidate.row.pane_active === 1,
				selections,
			};
		}),
	};
}

async function readActiveEditorRows(
	dbPath: string,
	signal?: AbortSignal,
): Promise<{ ok: true; rows: RawZedRow[] } | { ok: false; error: string; details?: unknown }> {
	return readEditorRows(dbPath, ZED_ACTIVE_EDITORS_QUERY, signal);
}

async function readEditorRows(
	dbPath: string,
	query: string,
	signal?: AbortSignal,
): Promise<{ ok: true; rows: RawZedRow[] } | { ok: false; error: string; details?: unknown }> {
	try {
		const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", dbPath, query], {
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

function compareCandidatesByRecency(left: EditorCandidate, right: EditorCandidate): number {
	return (
		String(right.row.timestamp ?? "").localeCompare(String(left.row.timestamp ?? "")) ||
		Number(right.row.pane_active ?? 0) - Number(left.row.pane_active ?? 0) ||
		Number(right.row.tab_active ?? 0) - Number(left.row.tab_active ?? 0) ||
		Number(left.row.position ?? 0) - Number(right.row.position ?? 0) ||
		left.key.localeCompare(right.key)
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

function zedReferenceItems(editors: ZedEditorRef[]): AutocompleteItem[] {
	const items: AutocompleteItem[] = [];
	for (const editor of editors) {
		const nonEmptySelections = editor.selections.filter((selection) => !selection.isEmpty);
		for (let index = 0; index < nonEmptySelections.length; index++) {
			const selection = nonEmptySelections[index]!;
			const suffix = nonEmptySelections.length > 1 ? `:${index}` : "";
			items.push({
				value: `${editor.ref}${suffix}`,
				label: `${editor.active ? "● " : ""}${editor.displayPath} ${formatSelectionSummary(selection)}`,
				description: `${editor.ref}${suffix}`,
			});
		}

		items.push({
			value: editor.fileRef,
			label: `${editor.active ? "● " : ""}${editor.displayPath}`,
			description: editor.fileRef,
		});
	}
	return items;
}

function createZedAutocompleteProvider(current: AutocompleteProvider, getEditors: () => Promise<ZedEditorsResult>): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const currentLine = lines[cursorLine] ?? "";
			const textBeforeCursor = currentLine.slice(0, cursorCol);
			const match = textBeforeCursor.match(/(?:^|[ \t])(@zed:[^\s]*)$/);
			if (!match) return current.getSuggestions(lines, cursorLine, cursorCol, options);

			const prefix = match[1]!;
			const result = await getEditors();
			if (options.signal.aborted || result.ok === false) return current.getSuggestions(lines, cursorLine, cursorCol, options);

			const allItems = zedReferenceItems(result.editors);
			const query = prefix.slice("@zed:".length).toLowerCase();
			const items = (query.length === 0
				? allItems
				: allItems.filter((item) => `${item.value} ${item.label} ${item.description ?? ""}`.toLowerCase().includes(query)))
				.slice(0, MAX_AUTOCOMPLETE_ITEMS);
			return items.length > 0 ? { items, prefix } : current.getSuggestions(lines, cursorLine, cursorCol, options);
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

function expandZedReferences(text: string, editors: ZedEditorRef[]): string {
	return text.replace(/@zed:(file:([^\s]+)|\d+(?::\d+)?)/g, (token: string, _body: string, encodedPath: string | undefined) => {
		if (encodedPath) {
			const decodedPath = decodeZedRef(encodedPath);
			const editor = editors.find((item) => item.filePath === decodedPath);
			if (!editor) return token;
			return formatZedBlock("file", editor, undefined, editor.contents, editor.contentsTruncated);
		}

		const match = token.match(/^@zed:(\d+)(?::(\d+))?$/);
		if (!match) return token;
		const editor = editors[Number(match[1])];
		if (!editor) return token;
		const nonEmptySelections = editor.selections.filter((selection) => !selection.isEmpty);
		const selection = nonEmptySelections[Number(match[2] ?? 0)] ?? nonEmptySelections[0];
		if (!selection) return token;
		return formatZedBlock("selection", editor, selection, selection.selectedText, selection.selectedTextTruncated);
	});
}

function formatZedBlock(kind: "selection" | "file", editor: ZedEditorRef, selection: ZedSelection | undefined, content: string, truncated: boolean): string {
	const lineAttr = selection ? ` lines="${selection.lineStart}-${selection.lineEnd}"` : "";
	const truncatedAttr = truncated ? ` truncated="true"` : "";
	return `<zed-${kind} file="${escapeXml(editor.displayPath)}"${lineAttr}${truncatedAttr}>\n${content}\n</zed-${kind}>`;
}

function encodeZedRef(value: string): string {
	return encodeURIComponent(value).replace(/%2F/g, "/");
}

function decodeZedRef(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
