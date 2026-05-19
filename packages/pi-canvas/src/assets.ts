export const ALLOWED_ASSET_ORIGINS = [
	"http://127.0.0.1",
	"https://cdn.jsdelivr.net",
	"https://unpkg.com",
] as const;

// Scripts only ever load from the canvas itself plus the pinned mermaid bundle.
// Keeping the broad asset allowlist out of script-src limits the blast radius if
// markup sanitization is ever bypassed.
export const ALLOWED_SCRIPT_ORIGINS = ["https://cdn.jsdelivr.net"] as const;

export function buildCanvasCsp(
	origins: readonly string[] = ALLOWED_ASSET_ORIGINS,
	scriptOrigins: readonly string[] = ALLOWED_SCRIPT_ORIGINS,
): string {
	const sourceList = ["'self'", ...origins].join(" ");
	const scriptList = ["'self'", ...scriptOrigins].join(" ");
	return [
		`default-src ${sourceList}`,
		`script-src ${scriptList}`,
		// Mermaid emits an inline <style> inside its rendered SVG, so inline
		// styles must be allowed. Style injection can't execute JS, and the
		// img-src/connect-src allowlists block url()-based exfiltration.
		`style-src ${sourceList} 'unsafe-inline'`,
		`img-src ${sourceList} data:`,
		`font-src ${sourceList}`,
		`connect-src ${sourceList}`,
		"object-src 'none'",
		"base-uri 'none'",
		"frame-ancestors 'none'",
	].join("; ");
}
