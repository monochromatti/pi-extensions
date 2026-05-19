import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

type RootPackageJson = {
	workspaces?: string[];
	scripts?: Record<string, string>;
};

type CanvasPackageJson = {
	name?: string;
	scripts?: Record<string, string>;
};

function readRootPackage(): RootPackageJson {
	const raw = readFileSync(new URL("../../../package.json", import.meta.url), "utf8");
	return JSON.parse(raw) as RootPackageJson;
}

function readCanvasPackage(): CanvasPackageJson {
	const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
	return JSON.parse(raw) as CanvasPackageJson;
}

test("8.1/8.2 root check wiring includes pi-canvas workspace checks", () => {
	const root = readRootPackage();
	const canvas = readCanvasPackage();

	const workspaceIncludesCanvas =
		root.workspaces?.includes("packages/*") || root.workspaces?.includes("packages/pi-canvas");
	assert.equal(workspaceIncludesCanvas, true);

	const rootCheck = root.scripts?.check ?? "";
	assert.match(rootCheck, /--workspaces/);
	assert.match(rootCheck, /check/);

	assert.equal(canvas.name, "@monochromatti/pi-canvas");
	assert.equal(typeof canvas.scripts?.check, "string");
});
