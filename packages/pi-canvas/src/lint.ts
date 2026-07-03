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
