import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { captureSingleOutputSnapshot } from "../../src/runs/shared/single-output.ts";
import { finalizeChildOutput } from "../../src/runs/shared/output-finalizer.ts";

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-output-finalizer-"));
}

test("2.1/2.2 raw output passes through unchanged without output path", () => {
	const result = finalizeChildOutput({ rawOutput: "hello\nworld", exitCode: 0 });
	assert.equal(result.fullOutput, "hello\nworld");
	assert.equal(result.displayOutput, "hello\nworld");
	assert.equal(result.savedPath, undefined);
	assert.equal(result.outputReference, undefined);
});

test("2.3/2.4 attempt notes are prepended and trimmed", () => {
	const result = finalizeChildOutput({
		rawOutput: " final output ",
		exitCode: 0,
		attemptNotes: ["", " retry model-a -> model-b "],
	});
	assert.equal(result.displayOutput, "retry model-a -> model-b\n\n final output");
	assert.equal(result.fullOutput, " final output ");
});

test("2.5/2.6 successful output path reads changed saved content and returns reference", () => {
	const dir = tempDir();
	try {
		const outputPath = path.join(dir, "child-output.md");
		const snapshot = captureSingleOutputSnapshot(outputPath);
		fs.writeFileSync(outputPath, "saved child output", "utf-8");
		const result = finalizeChildOutput({
			rawOutput: "stdout fallback",
			exitCode: 0,
			outputPath,
			outputSnapshot: snapshot,
		});
		assert.equal(result.fullOutput, "saved child output");
		assert.equal(result.savedPath, outputPath);
		assert.equal(result.outputReference?.path, outputPath);
		assert.match(result.displayOutput, /^saved child output\n\nOutput saved to:/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("2.7/2.8 file-only mode displays reference without full output", () => {
	const dir = tempDir();
	try {
		const outputPath = path.join(dir, "child-output.md");
		const result = finalizeChildOutput({
			rawOutput: "secret long output",
			exitCode: 0,
			outputPath,
			outputSnapshot: captureSingleOutputSnapshot(outputPath),
			outputMode: "file-only",
		});
		assert.equal(result.fullOutput, "secret long output");
		assert.equal(result.savedPath, outputPath);
		assert.match(result.displayOutput, /^Output saved to:/);
		assert.equal(result.displayOutput.includes("secret long output"), false);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
