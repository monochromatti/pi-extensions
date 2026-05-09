import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRunArtifacts } from "../../src/runs/shared/run-artifacts.ts";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-run-artifacts-"));
}

test("3.1 disabled artifacts do not create input/output/metadata files", () => {
	const tempDir = makeTempDir();
	const artifactsDir = path.join(tempDir, "artifacts");
	try {
		const artifacts = createRunArtifacts({
			artifactsDir,
			artifactConfig: { enabled: false },
			runId: "run-1",
			agent: "worker",
		});
		artifacts.recordInput("Implement feature");
		artifacts.recordResult({
			task: "Implement feature",
			output: "done",
			exitCode: 0,
		});
		assert.equal(fs.existsSync(artifactsDir), false);
		assert.equal(artifacts.paths, undefined);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("3.3 enabled artifacts write task input with heading and agent", () => {
	const tempDir = makeTempDir();
	const artifactsDir = path.join(tempDir, "artifacts");
	try {
		const artifacts = createRunArtifacts({
			artifactsDir,
			artifactConfig: { enabled: true },
			runId: "run-2",
			agent: "worker",
			index: 2,
		});
		artifacts.recordInput("Implement run artifacts");
		assert.ok(artifacts.paths);
		assert.equal(fs.existsSync(artifacts.paths!.inputPath), true);
		assert.equal(fs.readFileSync(artifacts.paths!.inputPath, "utf-8"), "# Task for worker\n\nImplement run artifacts");
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("3.5 include flags independently suppress input/output/metadata writes", () => {
	for (const config of [
		{ includeInput: false, includeOutput: true, includeMetadata: true },
		{ includeInput: true, includeOutput: false, includeMetadata: true },
		{ includeInput: true, includeOutput: true, includeMetadata: false },
	]) {
		const tempDir = makeTempDir();
		const artifactsDir = path.join(tempDir, "artifacts");
		try {
			const artifacts = createRunArtifacts({
				artifactsDir,
				artifactConfig: { enabled: true, ...config },
				runId: "run-3",
				agent: "worker",
			});
			artifacts.recordInput("Task");
			artifacts.recordResult({
				task: "Task",
				output: "Output",
				exitCode: 0,
			});
			assert.ok(artifacts.paths);
			assert.equal(fs.existsSync(artifacts.paths!.inputPath), config.includeInput);
			assert.equal(fs.existsSync(artifacts.paths!.outputPath), config.includeOutput);
			assert.equal(fs.existsSync(artifacts.paths!.metadataPath), config.includeMetadata);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	}
});

test("3.7 metadata contains run fields and timestamp", () => {
	const tempDir = makeTempDir();
	const artifactsDir = path.join(tempDir, "artifacts");
	try {
		const artifacts = createRunArtifacts({
			artifactsDir,
			artifactConfig: { enabled: true },
			runId: "run-4",
			agent: "worker",
		});
		artifacts.recordResult({
			task: "Implement",
			output: "done",
			exitCode: 1,
			model: "model-a",
			attemptedModels: ["model-a", "model-b"],
			modelAttempts: [{ model: "model-a", success: false, exitCode: 1, error: "failed" }],
			skills: ["skill-1"],
		});
		assert.ok(artifacts.paths);
		const metadata = JSON.parse(fs.readFileSync(artifacts.paths!.metadataPath, "utf-8")) as Record<string, unknown>;
		assert.equal(metadata.runId, "run-4");
		assert.equal(metadata.agent, "worker");
		assert.equal(metadata.task, "Implement");
		assert.equal(metadata.exitCode, 1);
		assert.equal(metadata.model, "model-a");
		assert.deepEqual(metadata.attemptedModels, ["model-a", "model-b"]);
		assert.deepEqual(metadata.modelAttempts, [{ model: "model-a", success: false, exitCode: 1, error: "failed" }]);
		assert.deepEqual(metadata.skills, ["skill-1"]);
		assert.equal(typeof metadata.timestamp, "number");
		assert.ok((metadata.timestamp as number) > 0);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
