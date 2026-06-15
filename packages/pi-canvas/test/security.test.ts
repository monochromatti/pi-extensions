import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeCanvasHtml } from "../src/security.ts";

test("4.7 sanitizer strips script/style tags, inline handlers, javascript urls, style attrs", () => {
	const result = sanitizeCanvasHtml(
		"<div onclick=\"x()\" style=\"background:url(https://evil.example/x)\"><style>.x{color:red}</style><style media=\"screen\"/><script>alert(1)</script><a href=\"javascript:alert(2)\">go</a><button onmouseover=\"x()\">b</button></div>",
	);
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.html.includes("<script"), false);
	assert.equal(result.html.includes("<style"), false);
	assert.equal(/\son[a-z]+\s*=/.test(result.html), false);
	assert.equal(/\sstyle\s*=/.test(result.html), false);
	assert.equal(result.html.toLowerCase().includes("javascript:"), false);
});

test("4.7 sanitizer blocks non-allowlisted remote assets", () => {
	const result = sanitizeCanvasHtml("<img src=\"https://evil.example/a.png\">");
	assert.deepEqual(result, { ok: false, error: "disallowed_remote_asset" });
});

test("4.7 sanitizer blocks encoded javascript protocols in href/src", () => {
	const hrefResult = sanitizeCanvasHtml("<a href=\"jav&#x61;script:alert(1)\">x</a>");
	assert.deepEqual(hrefResult, { ok: false, error: "disallowed_remote_asset" });

	const srcResult = sanitizeCanvasHtml("<img src=\"jav&#97;script:alert(2)\">");
	assert.deepEqual(srcResult, { ok: false, error: "disallowed_remote_asset" });
});

test("4.8 sanitizer blocks case-insensitive http(s) schemes outside allowlist", () => {
	const blockedUppercaseScheme = sanitizeCanvasHtml("<img src=\"HTTPS://evil.example/a.png\">");
	assert.deepEqual(blockedUppercaseScheme, { ok: false, error: "disallowed_remote_asset" });
});

test("4.8 sanitizer blocks named entity colon javascript protocol in href/src and srcset", () => {
	const hrefResult = sanitizeCanvasHtml("<a href=\"java&colon;script:alert(1)\">x</a>");
	assert.deepEqual(hrefResult, { ok: false, error: "disallowed_remote_asset" });

	const srcResult = sanitizeCanvasHtml("<img src=\"java&colon;script:alert(2)\">");
	assert.deepEqual(srcResult, { ok: false, error: "disallowed_remote_asset" });

	const srcsetResult = sanitizeCanvasHtml("<img srcset=\"java&colon;script:alert(3) 1x\">");
	assert.deepEqual(srcsetResult, { ok: false, error: "disallowed_remote_asset" });
});

test("4.8 sanitizer enforces allowlist on srcset urls", () => {
	const blocked = sanitizeCanvasHtml("<img srcset=\"https://cdn.jsdelivr.net/a.png 1x, https://evil.example/b.png 2x\">");
	assert.deepEqual(blocked, { ok: false, error: "disallowed_remote_asset" });

	const allowed = sanitizeCanvasHtml("<img srcset=\"https://cdn.jsdelivr.net/a.png 1x, https://unpkg.com/b.png 2x\">");
	assert.equal(allowed.ok, true);
});

test("4.8 sanitizer strips unclosed/self-closing script + style openers", () => {
	const unclosedScript = sanitizeCanvasHtml('<script src="https://cdn.jsdelivr.net/gh/x/y/evil.js">');
	assert.equal(unclosedScript.ok, true);
	if (unclosedScript.ok) {
		assert.equal(unclosedScript.html.toLowerCase().includes("<script"), false);
	}

	const inlineUnclosed = sanitizeCanvasHtml("<script>alert(1)");
	assert.equal(inlineUnclosed.ok, true);
	if (inlineUnclosed.ok) {
		assert.equal(inlineUnclosed.html.toLowerCase().includes("<script"), false);
	}

	const unclosedStyle = sanitizeCanvasHtml("<style media=screen>body{display:none}");
	assert.equal(unclosedStyle.ok, true);
	if (unclosedStyle.ok) {
		assert.equal(unclosedStyle.html.toLowerCase().includes("<style"), false);
	}
});

test("4.8 sanitizer allows allowlisted remote assets", () => {
	const result = sanitizeCanvasHtml("<script src=\"https://cdn.jsdelivr.net/npm/x.js\"></script><img src=\"https://unpkg.com/x.png\">");
	assert.equal(result.ok, true);
});

test("security regression: huge numeric entity does not throw", () => {
	let result: ReturnType<typeof sanitizeCanvasHtml> | undefined;
	assert.doesNotThrow(() => {
		result = sanitizeCanvasHtml("<img src=\"jav&#999999999999999999999;script:alert(1)\">");
	});
	assert.ok(result);
	assert.equal(typeof result.ok, "boolean");
});

test("security regression: style tags stripped in render pipeline", () => {
	const result = sanitizeCanvasHtml("<style>body{display:none}</style><style/><p>ok</p>");
	assert.equal(result.ok, true);
	if (!result.ok) return;
	assert.equal(result.html.includes("<style"), false);
	assert.match(result.html, /<p>ok<\/p>/);
});
