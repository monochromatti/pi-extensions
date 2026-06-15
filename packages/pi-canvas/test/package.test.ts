import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

function readPackageJson() {
	const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
	return JSON.parse(raw) as {
		pi?: { extensions?: string[]; skills?: string[] };
		scripts?: Record<string, string>;
	};
}

test("1.1 package manifest exposes extension, skills, and scripts", () => {
	const pkg = readPackageJson();
	assert.deepEqual(pkg.pi?.extensions, ["./index.ts"]);
	assert.deepEqual(pkg.pi?.skills, ["./skills"]);
	assert.equal(typeof pkg.scripts?.test, "string");
	assert.equal(typeof pkg.scripts?.check, "string");
});
