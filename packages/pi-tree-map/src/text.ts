const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

export function visibleLength(text: string): number {
	return stripAnsi(text).length;
}

export function truncate(text: string, maxLength: number): string {
	if (maxLength <= 0) return "";
	if (maxLength === 1) return text.length > 1 ? "…" : text;
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength - 1)}…`;
}

export function compactWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
