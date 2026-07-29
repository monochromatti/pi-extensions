/**
 * Design linter for canvas renders.
 *
 * Warnings (never errors) returned to the agent inside the canvas_render tool
 * result. This is the feedback loop that lets weaker agents self-correct:
 * the render still applies, but the agent is told exactly what to fix and
 * with which vocabulary.
 */

export const CANVAS_HELPER_CLASSES = [
	"badge",
	"btn-primary",
	"btn-quiet",
	"callout",
	"card",
	"danger",
	"field",
	"grid",
	"info",
	"muted",
	"row",
	"stack",
	"success",
	"toolbar",
	"warning",
] as const;

const HELPER_CLASS_SET = new Set<string>(CANVAS_HELPER_CLASSES);
const REACTIVE_KEY_PATTERN = /^!?[a-z0-9_.-]+$/i;

export type LintContext = {
	selector: string;
	html: string;
	rootAppendStreak?: number;
};

export function lintCanvasHtml(context: LintContext): string[] {
	const warnings: string[] = [];
	const html = context.html;
	// Component bodies hold escaped code, markdown, or mermaid source; their
	// text would trip attribute-pattern checks meant for real markup.
	const markup = stripComponentContent(html);

	if (/<style\b/i.test(html) || /\sstyle\s*=/i.test(markup)) {
		warnings.push(
			`Inline styles and <style> blocks are stripped before render. Use the helper classes instead: ${CANVAS_HELPER_CLASSES.join(", ")}.`,
		);
	}

	if (/<script\b/i.test(html)) {
		warnings.push("<script> is stripped before render. Interactivity comes from data-signal, data-event, data-show, and data-enable-when.");
	}

	const unknownClasses = collectUnknownClasses(markup);
	if (unknownClasses.length > 0) {
		warnings.push(
			`Unknown class${unknownClasses.length > 1 ? "es" : ""} ${unknownClasses.map((name) => `"${name}"`).join(", ")} — no styles exist for ${unknownClasses.length > 1 ? "them" : "it"}. Allowed classes: ${CANVAS_HELPER_CLASSES.join(", ")}. Bare semantic HTML is styled automatically.`,
		);
	}

	const paragraphCount = countMatches(markup, /<p[\s>]/gi);
	if (paragraphCount >= 3) {
		warnings.push("Long prose is easier to author and better typeset inside <markdown-block> than as hand-written <p> tags.");
	}

	warnings.push(...lintReadingLoad(context, html, markup));
	warnings.push(...lintFeedbackControls(markup));

	const cardCount = countMatches(markup, /\bclass\s*=\s*(?:"[^"]*\bcard\b[^"]*"|'[^']*\bcard\b[^']*')/gi);
	if (cardCount >= 4) {
		warnings.push(
			`${cardCount} cards in one render creates repetitive container chrome. Use plain sections, headings, rules, or whitespace unless elevation communicates hierarchy.`,
		);
	}

	const longButtons = collectLongButtonLabels(markup);
	if (longButtons.length > 0) {
		warnings.push(
			`Long button label${longButtons.length > 1 ? "s" : ""} ${longButtons.map((label) => `"${label}"`).join(", ")} may wrap or obscure intent. Prefer concise action labels (roughly 3 words).`,
		);
	}

	const headingJump = findHeadingLevelJump(markup);
	if (headingJump) {
		warnings.push(`Heading hierarchy jumps from <h${headingJump.from}> to <h${headingJump.to}>. Use consecutive levels so document structure remains accessible.`);
	}

	if (context.selector === "#root" && visibleTextLength(html) > 2000 && !/\bdata-canvas-slot\s*=/i.test(markup)) {
		warnings.push("Large #root documents need named data-canvas-slot sections so revisions can patch one section without replacing the whole document.");
	}

	if (context.selector === "#status" && visibleTextLength(html) > 140) {
		warnings.push("#status is a one-line strip; keep it to a short phrase and put content in #root.");
	}

	const unboundControls = collectUnboundControls(markup);
	if (unboundControls.length > 0) {
		warnings.push(
			`<${unboundControls.join(">, <")}> without data-signal never reaches canvas_read_signals. Add data-signal="<key>" to every input control.`,
		);
	}

	if (/<button\b(?![^>]*\bdata-event\s*=)[^>]*>/i.test(markup)) {
		warnings.push('A <button> without data-event does nothing. Use data-event="attention:<name>" (request revision) or data-event="checkpoint:<name>" (approve/continue).');
	}

	for (const attribute of ["data-show", "data-enable-when"]) {
		for (const match of markup.matchAll(new RegExp(`\\b${attribute}\\s*=\\s*("([^"]*)"|'([^']*)')`, "gi"))) {
			const value = (match[2] ?? match[3] ?? "").trim();
			if (!REACTIVE_KEY_PATTERN.test(value)) {
				warnings.push(`${attribute}="${value}" is ignored: only a bare signal key (optionally prefixed with !) is allowed, e.g. ${attribute}="feedback.global".`);
			}
		}
	}

	if (context.selector === "#root" && (context.rootAppendStreak ?? 0) >= 3) {
		warnings.push(
			`You have appended to #root ${context.rootAppendStreak} times in a row; the page grows unbounded. Render named slots (data-canvas-slot) and patch them with mode "inner" instead.`,
		);
	}

	return warnings;
}

/** Reading load: canvas exists to compress information, not to host essays. */
const WALL_OF_TEXT_CHARS = 1200;
const SLOT_BUDGET_CHARS = 5000;
const LONG_PARAGRAPH_CHARS = 450;

function lintReadingLoad(context: LintContext, html: string, markup: string): string[] {
	const warnings: string[] = [];
	const textLength = readableTextLength(html);

	if (textLength > WALL_OF_TEXT_CHARS && !hasVisualStructure(html, markup)) {
		warnings.push(
			`${textLength} characters of unbroken prose with no table, list, diagram, code block, or <details>. Compress it: a comparison table, a mermaid diagram, a bulleted decision list, or a diff usually replaces most of the paragraphs.`,
		);
	}

	if (textLength > SLOT_BUDGET_CHARS) {
		warnings.push(
			`${textLength} characters in one render is more than a reader scans. Keep the visible layer to headline + evidence, and move supporting detail into <details> or a separate slot rendered on request.`,
		);
	}

	const longParagraph = findLongParagraph(html, markup);
	if (longParagraph) {
		warnings.push(
			`Paragraph starting "${longParagraph.preview}" runs ${longParagraph.length} characters. Break it into bullets, a table row per point, or a diagram — dense paragraphs are the format users skip.`,
		);
	}

	return warnings;
}

function hasVisualStructure(html: string, markup: string): boolean {
	if (/<(code-block|mermaid-diagram|table|details|ul|ol|img)\b/i.test(markup)) return true;
	if (/\bclass\s*=\s*("[^"]*\b(grid|row|badge)\b[^"]*"|'[^']*\b(grid|row|badge)\b[^']*')/i.test(markup)) {
		return true;
	}
	// Markdown source inside components: tables, lists, task lists, headings.
	if (/^\s*\|.*\|\s*$/m.test(html) && /\|\s*-{3,}/.test(html)) return true;
	if (/^\s*(?:[-*+]\s+|\d+\.\s+)/m.test(html)) return true;
	return false;
}

/**
 * Reading load is prose the user must scan now: code, diagram source, table
 * rows, and collapsed <details> are all cheap to skip, so counting them would
 * push agents to strip the very structures that make a canvas readable.
 */
function readableTextLength(html: string): number {
	const prose = html
		.replace(/<(code-block|mermaid-diagram)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/<details\b[^>]*>[\s\S]*?<\/details\s*>/gi, "")
		.replace(/^\s*\|.*$/gm, "");
	return visibleTextLength(prose);
}

function findLongParagraph(html: string, markup: string): { preview: string; length: number } | undefined {
	for (const chunk of collectProseChunks(html, markup)) {
		const text = chunk.replace(/\s+/g, " ").trim();
		if (text.length <= LONG_PARAGRAPH_CHARS) continue;
		return { preview: `${text.slice(0, 40)}…`, length: text.length };
	}
	return undefined;
}

function collectProseChunks(html: string, markup: string): string[] {
	const chunks: string[] = [];

	for (const match of html.matchAll(/<markdown-block\b[^>]*>([\s\S]*?)<\/markdown-block\s*>/gi)) {
		for (const block of (match[1] ?? "").split(/\n\s*\n/)) {
			// Structured blocks (lists, tables, quotes, headings) are already compact.
			if (/^\s*(?:[-*+>#]|\d+\.|\|)/m.test(block)) continue;
			chunks.push(block);
		}
	}

	// markup, not html: <p> written inside a code sample is not a paragraph.
	for (const match of markup.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)) {
		chunks.push((match[1] ?? "").replace(/<[^>]*>/g, " "));
	}

	return chunks;
}

/**
 * Freeform comment boxes are built into the canvas: users select text and
 * comment on it. Rendered controls should therefore encode decisions the agent
 * cannot make alone, not a generic "any thoughts?" prompt.
 */
const FEEDBACK_SIGNAL_PREFIX = /^(?:feedback|notes?|comments?|review|thoughts|remarks)\b/i;

function lintFeedbackControls(markup: string): string[] {
	const warnings: string[] = [];
	const textareas = [...markup.matchAll(/<textarea\b[^>]*>/gi)].map((match) => match[0]);
	// Free text also arrives via bare <input>; the doctrine is about the channel,
	// not the tag.
	const freeTextInputs = [...markup.matchAll(/<input\b[^>]*>/gi)].map((match) => match[0]).filter(isFreeTextInput);

	const genericKeys = [...textareas, ...freeTextInputs]
		.map((tag) => tag.match(/\bdata-signal\s*=\s*("([^"]*)"|'([^']*)')/i))
		.map((match) => (match?.[2] ?? match?.[3] ?? "").trim())
		.filter((key) => key.length > 0 && FEEDBACK_SIGNAL_PREFIX.test(key));

	if (genericKeys.length > 0) {
		warnings.push(
			`Feedback box (data-signal="${genericKeys[0]}") duplicates built-in selection comments — users can already select any text and comment on it. Render controls only for open decisions (a choice the agent cannot settle), or drop the panel.`,
		);
	}

	if (textareas.length >= 3) {
		warnings.push(
			`${textareas.length} freeform text boxes in one render. Per-section comment fields are unnecessary: selection comments carry the quoted context. Keep at most one input, bound to a real open question.`,
		);
	}

	return warnings;
}

function isFreeTextInput(tag: string): boolean {
	const match = tag.match(/\btype\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
	const type = (match?.[2] ?? match?.[3] ?? match?.[4] ?? "text").trim().toLowerCase();
	return type === "text" || type === "search";
}

function stripComponentContent(html: string): string {
	return html.replace(/<(code-block|markdown-block|mermaid-diagram)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "<$1></$1>");
}

function collectUnknownClasses(markup: string): string[] {
	const unknown = new Set<string>();
	for (const match of markup.matchAll(/\bclass\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
		const value = match[2] ?? match[3] ?? "";
		for (const name of value.split(/\s+/)) {
			if (name && !HELPER_CLASS_SET.has(name)) {
				unknown.add(name);
			}
		}
	}
	return [...unknown];
}

function collectUnboundControls(markup: string): string[] {
	const unbound = new Set<string>();
	for (const match of markup.matchAll(/<(textarea|input|select)\b[^>]*>/gi)) {
		if (!/\bdata-signal\s*=/i.test(match[0])) {
			unbound.add(match[1]!.toLowerCase());
		}
	}
	return [...unbound];
}

function collectLongButtonLabels(markup: string): string[] {
	const labels: string[] = [];
	for (const match of markup.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button\s*>/gi)) {
		const text = (match[1] ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
		if (text.length > 32 || text.split(/\s+/).filter(Boolean).length > 5) labels.push(text.slice(0, 48));
	}
	return labels;
}

function findHeadingLevelJump(markup: string): { from: number; to: number } | undefined {
	let previous: number | undefined;
	for (const match of markup.matchAll(/<h([1-6])\b/gi)) {
		const current = Number(match[1]);
		if (previous !== undefined && current > previous + 1) return { from: previous, to: current };
		previous = current;
	}
	return undefined;
}

function visibleTextLength(html: string): number {
	return html
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim().length;
}

function countMatches(value: string, pattern: RegExp): number {
	let count = 0;
	for (const _ of value.matchAll(pattern)) count++;
	return count;
}
