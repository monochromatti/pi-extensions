import { ALLOWED_ASSET_ORIGINS } from "./assets.ts";

export type SanitizeResult =
	| { ok: true; html: string }
	| { ok: false; error: "disallowed_remote_asset" };

export function sanitizeCanvasHtml(html: string): SanitizeResult {
	let sanitized = html;

	// Remove well-formed elements first, then strip any leftover opener
	// (unclosed/self-closing tags). An unclosed `<script src="…allowlisted…">`
	// would otherwise survive and execute, since allowlisted CDNs serve
	// arbitrary code.
	sanitized = sanitized.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "");
	sanitized = sanitized.replace(/<script\b[^>]*>/gi, "");
	sanitized = sanitized.replace(/<style\b[\s\S]*?<\/style\s*>/gi, "");
	sanitized = sanitized.replace(/<style\b[^>]*>/gi, "");
	sanitized = sanitized.replace(/\son[a-z0-9_-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
	sanitized = sanitized.replace(/\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
	sanitized = sanitized.replace(/\s(href|src)\s*=\s*"\s*javascript:[^"]*"/gi, "");
	sanitized = sanitized.replace(/\s(href|src)\s*=\s*'\s*javascript:[^']*'/gi, "");
	sanitized = sanitized.replace(/\s(href|src)\s*=\s*javascript:[^\s>]+/gi, "");

	if (!hasOnlyAllowedRemoteAssets(sanitized)) {
		return { ok: false, error: "disallowed_remote_asset" };
	}

	return { ok: true, html: sanitized };
}

function hasOnlyAllowedRemoteAssets(html: string): boolean {
	const srcHrefPattern = /\b(?:src|href)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
	for (const match of html.matchAll(srcHrefPattern)) {
		const rawValue = match[2] ?? match[3] ?? match[4] ?? "";
		if (!isAllowedAssetUrl(rawValue)) {
			return false;
		}
	}

	const srcsetPattern = /\bsrcset\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
	for (const match of html.matchAll(srcsetPattern)) {
		const rawValue = match[2] ?? match[3] ?? match[4] ?? "";
		for (const candidate of parseSrcsetUrls(rawValue)) {
			if (!isAllowedAssetUrl(candidate)) {
				return false;
			}
		}
	}

	return true;
}

function parseSrcsetUrls(value: string): string[] {
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => entry.split(/\s+/)[0] ?? "")
		.filter(Boolean);
}

function isAllowedAssetUrl(rawValue: string): boolean {
	const value = rawValue.trim();
	if (!value) return true;

	const decodedValue = decodeHtmlEntities(value);
	const normalized = decodedValue.replace(/[\u0000-\u0020]+/g, "").toLowerCase();
	if (/^java:?script:/.test(normalized)) return false;
	if (normalized.startsWith("//")) return false;

	if (/^https?:\/\//i.test(decodedValue)) {
		try {
			const origin = new URL(decodedValue).origin;
			if (!ALLOWED_ASSET_ORIGINS.includes(origin as (typeof ALLOWED_ASSET_ORIGINS)[number])) {
				return false;
			}
		} catch {
			return false;
		}
	}

	return true;
}

function decodeHtmlEntities(value: string): string {
	return value
		.replace(/&#(\d+);?/g, (match, dec) => decodeNumericEntity(match, dec, 10))
		.replace(/&#x([0-9a-f]+);?/gi, (match, hex) => decodeNumericEntity(match, hex, 16))
		.replace(/&colon;?/gi, ":");
}

function decodeNumericEntity(match: string, rawValue: string, radix: 10 | 16): string {
	const codePoint = Number.parseInt(rawValue, radix);
	if (!Number.isInteger(codePoint)) return match;
	if (codePoint < 0 || codePoint > 0x10ffff) return match;
	return String.fromCodePoint(codePoint);
}
