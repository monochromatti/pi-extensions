import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("5.7 styles include required helper classes", () => {
	const css = readFileSync(new URL("../static/styles.css", import.meta.url), "utf8");

	for (const className of ["callout", "warning", "grid", "muted", "badge", "diff-add", "diff-del"]) {
		assert.match(css, new RegExp(`\\.${className}\\b`));
	}
});
