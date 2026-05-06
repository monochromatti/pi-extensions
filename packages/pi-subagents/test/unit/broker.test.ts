import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { getBrokerSocketPath } from "../../src/intercom-public/broker/paths.ts";
import {
	getBrokerLaunchSpec,
	getBrokerSpawnOptions,
	getTsxCliPath,
	getWindowsHiddenLauncherScript,
	getWindowsBrokerCommandLine,
	getWindowsHiddenLauncherPath,
} from "../../src/intercom-public/broker/spawn.ts";

test("7.1 broker socket path uses named pipe on Windows", () => {
	const pipePath = getBrokerSocketPath("win32", "C:/Users/pi");
	assert.match(pipePath, /^\\\\\.\\pipe\\pi-intercom-/);
	assert.doesNotMatch(pipePath, /broker\.sock$/);
});

test("7.1 broker socket path uses broker.sock on non-Windows", () => {
	const socketPath = getBrokerSocketPath("linux", "/home/pi");
	assert.match(socketPath, /broker\.sock$/);
	assert.match(socketPath, /pi/);
});

test("7.1 broker spawn helpers build direct non-Windows launch specs", () => {
	const spec = getBrokerLaunchSpec("/repo/broker.ts", "npx", ["--no-install", "tsx"], "/repo", "linux", "/tmp/intercom", "/usr/bin/node");
	assert.equal(spec.command, "npx");
	assert.deepEqual(spec.args, ["--no-install", "tsx", "/repo/broker.ts"]);
	assert.equal(spec.kind, "direct");

	const custom = getBrokerLaunchSpec("/repo/broker.ts", "bun", [], "/repo", "linux", "/tmp/intercom", "/usr/bin/node");
	assert.equal(custom.command, "bun");
	assert.deepEqual(custom.args, ["/repo/broker.ts"]);
	assert.equal(custom.kind, "direct");
});

test("7.1 broker spawn helpers build hidden Windows launcher specs without writing launcher eagerly", () => {
	const intercomDir = mkdtempSync(path.join(tmpdir(), "pi-intercom-"));
	try {
		assert.equal(getTsxCliPath("C:/repo"), path.join("C:/repo", "node_modules", "tsx", "dist", "cli.mjs"));
		assert.equal(getWindowsHiddenLauncherPath(intercomDir), path.join(intercomDir, "broker-launch.vbs"));
		assert.equal(
			getWindowsBrokerCommandLine("C:/repo/broker.ts", "C:/repo", "C:/Program Files/nodejs/node.exe"),
			`"C:/Program Files/nodejs/node.exe" "${path.join("C:/repo", "node_modules", "tsx", "dist", "cli.mjs")}" "C:/repo/broker.ts"`,
		);
		assert.match(getWindowsHiddenLauncherScript('"node" "broker.ts"'), /WshShell\.Run/);
		assert.match(getWindowsHiddenLauncherScript('"node" "broker.ts"'), /, 0, False/);

		const spec = getBrokerLaunchSpec(
			"C:/repo/broker.ts",
			"npx",
			["--no-install", "tsx"],
			"C:/repo",
			"win32",
			intercomDir,
			"C:/Program Files/nodejs/node.exe",
		);
		assert.equal(spec.command, "wscript.exe");
		assert.deepEqual(spec.args, [path.join(intercomDir, "broker-launch.vbs")]);
		assert.equal(spec.kind, "windows-launcher");
		assert.equal(existsSync(path.join(intercomDir, "broker-launch.vbs")), false);
	} finally {
		rmSync(intercomDir, { recursive: true, force: true });
	}
});

test("7.1 broker spawn options keep detached hidden defaults", () => {
	const options = getBrokerSpawnOptions("/repo");
	assert.equal(options.windowsHide, true);
	assert.equal(options.detached, true);
	assert.equal(options.stdio, "ignore");
	assert.equal(options.cwd, "/repo");
});
