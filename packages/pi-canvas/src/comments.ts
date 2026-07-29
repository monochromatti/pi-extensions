import type { CanvasSessionState } from "./session.ts";

/**
 * Selection comments are the one canvas event whose text the agent renders and
 * the user quotes back. They therefore never travel through the generic
 * attention route: agent-authored HTML can post arbitrary attention payloads,
 * so a forged `kind: "selection-comment"` would let a render inject text into
 * the transcript as if the user wrote it. The dedicated /comment route builds
 * the record server-side from validated fields only.
 */
export type CanvasSelectionComment = {
	kind: "selection-comment";
	index: number;
	slot?: string;
	quote: string;
	note: string;
	at: string;
};

export const COMMENTS_SIGNAL_KEY = "comments";

const MAX_QUOTE_CHARS = 400;
const MAX_NOTE_CHARS = 2000;
const SLOT_PATTERN = /^[a-z0-9_-]{1,40}$/i;
const MAX_COMMENTS = 200;

export function buildSelectionComment(session: CanvasSessionState, body: unknown): CanvasSelectionComment | undefined {
	if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
	const input = body as Record<string, unknown>;

	const quote = normalizeQuote(input.quote, MAX_QUOTE_CHARS);
	const note = normalizeNote(input.note, MAX_NOTE_CHARS);
	if (!quote || !note) return undefined;

	const rawSlot = typeof input.slot === "string" ? input.slot.trim() : "";
	const slot = SLOT_PATTERN.test(rawSlot) ? rawSlot : undefined;

	return {
		kind: "selection-comment",
		index: nextCommentIndex(readComments(session)),
		...(slot ? { slot } : {}),
		quote,
		note,
		at: new Date().toISOString(),
	};
}

/** The list lives on the server so reloads, extra tabs, and racing /sync posts cannot drop history. */
export function appendComment(session: CanvasSessionState, comment: CanvasSelectionComment): CanvasSelectionComment[] {
	const comments = [...readComments(session), comment].slice(-MAX_COMMENTS);
	session.signals[COMMENTS_SIGNAL_KEY] = comments;
	return comments;
}

export function readComments(session: CanvasSessionState): CanvasSelectionComment[] {
	const existing = session.signals[COMMENTS_SIGNAL_KEY];
	if (!Array.isArray(existing)) return [];
	return existing.filter(
		(entry): entry is CanvasSelectionComment =>
			Boolean(entry) &&
			typeof entry === "object" &&
			(entry as CanvasSelectionComment).kind === "selection-comment" &&
			typeof (entry as CanvasSelectionComment).quote === "string" &&
			typeof (entry as CanvasSelectionComment).note === "string",
	);
}

function nextCommentIndex(comments: CanvasSelectionComment[]): number {
	const indexes = comments.map((comment) => comment.index).filter((index) => Number.isSafeInteger(index) && index > 0);
	return indexes.length > 0 ? Math.max(...indexes) + 1 : 1;
}

function normalizeQuote(value: unknown, maxChars: number): string {
	if (typeof value !== "string") return "";
	const text = value.replace(/\s+/g, " ").trim();
	return cap(text, maxChars);
}

/** Notes are the user's own prose: paragraph breaks are meaning, not noise. */
function normalizeNote(value: unknown, maxChars: number): string {
	if (typeof value !== "string") return "";
	const text = value
		.replace(/\r\n?/g, "\n")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return cap(text, maxChars);
}

function cap(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}
