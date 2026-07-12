import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

import { CANVAS_HELPER_CLASSES } from "../src/lint.ts";

test("5.7 styles include required helper classes", () => {
	const css = readFileSync(new URL("../static/styles.css", import.meta.url), "utf8");

	for (const className of ["callout", "warning", "grid", "muted", "badge", "diff-add", "diff-del"]) {
		assert.match(css, new RegExp(`\\.${className}\\b`));
	}
});

test("5.8 every lint-allowed helper class has styles", () => {
	const css = readFileSync(new URL("../static/styles.css", import.meta.url), "utf8");

	for (const className of CANVAS_HELPER_CLASSES) {
		assert.match(css, new RegExp(`\\.${className}\\b`), `missing styles for helper class "${className}"`);
	}
});

test("5.9 design substrate styles the shell, bare elements, and event-driven buttons", () => {
	const css = readFileSync(new URL("../static/styles.css", import.meta.url), "utf8");

	// The substrate must style semantic HTML with zero classes.
	for (const needle of [
		"font-family",
		"light-dark(",
		"#sidebar",
		"#status",
		"#root",
		'button[data-event^="checkpoint:"]',
		'button[data-event^="attention:"]',
		"textarea",
		"prefers-reduced-motion",
		"[hidden]",
	]) {
		assert.equal(css.includes(needle), true, `styles.css should contain ${needle}`);
	}
});

test("5.10 long actions and wide tables remain usable", () => {
	const css = readFileSync(new URL("../static/styles.css", import.meta.url), "utf8");
	const dom = new JSDOM(
		`<!doctype html><style>${css}</style><button>Approve the complete implementation</button><table><tbody><tr><td>wide content</td></tr></tbody></table>`,
		{ pretendToBeVisual: true },
	);
	const { document } = dom.window;

	assert.equal(dom.window.getComputedStyle(document.querySelector("button")!).whiteSpace, "nowrap");
	assert.equal(dom.window.getComputedStyle(document.querySelector("table")!).overflowX, "auto");
});
