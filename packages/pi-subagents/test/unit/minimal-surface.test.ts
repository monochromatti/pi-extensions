import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

test("package manifest exposes extension and skill without prompts", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.deepEqual(pkg.pi.extensions, ["./src/extension/index.ts"]);
  assert.deepEqual(pkg.pi.skills, ["./skills"]);
  assert.equal(pkg.pi.prompts, undefined);
  assert.ok(!pkg.files.some((entry: string) => entry.includes("prompts")));
  assert.ok(!pkg.files.some((entry: string) => entry.includes("CHANGELOG.md")));
  assert.ok(!pkg.files.some((entry: string) => entry.includes("*.mjs")));
  assert.ok(!pkg.files.some((entry: string) => entry.includes("banner")));
});

test("builtin agents ship expected set", () => {
  const agents = fs.readdirSync(path.join(root, "agents")).filter((name) => name.endsWith(".md")).sort();
  assert.deepEqual(agents, ["delegate.md", "oracle.md", "planner.md", "researcher.md", "reviewer.md", "worker.md"]);
});

test("subagent public description omits removed features", () => {
  const source = fs.readFileSync(path.join(root, "src/extension/index.ts"), "utf8");
  assert.ok(!source.includes("/parallel-review"));
  assert.ok(!source.includes("/parallel-cleanup"));
  assert.ok(!source.includes("{chain_dir} -"));
  assert.ok(!source.includes("worktree?: true"));
  assert.ok(!source.includes("MANAGEMENT ("));
});

test("intercom exposes tool only without command or shortcut", () => {
  const source = fs.readFileSync(path.join(root, "src/intercom-public/index.ts"), "utf8");
  assert.ok(source.includes("pi.registerTool"));
  assert.ok(!source.includes("registerCommand"));
  assert.ok(!source.includes("registerShortcut"));
});

function listTsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listTsFiles(fullPath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [fullPath] : [];
  });
}

test("duplicate upstream broker assets are not shipped", () => {
  assert.equal(fs.existsSync(path.join(root, "src/intercom-broker-upstream")), false);
});

test("docs cover supported and unsupported surface", () => {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const skill = fs.readFileSync(path.join(root, "skills/pi-subagents/SKILL.md"), "utf8");
  for (const text of [readme, skill]) {
    for (const required of ["subagent", "Single", "Parallel", "Chain", "Async", "intercom", "contact_supervisor"]) {
      assert.ok(text.includes(required), `docs should mention ${required}`);
    }
    for (const unsupported of ["prompt shortcuts", "chain files", "agent management", "clarify TUI", "worktree mode"]) {
      assert.ok(text.includes(unsupported), `docs should mention unsupported ${unsupported}`);
    }
    assert.ok(!text.includes("/parallel-review"));
    assert.ok(!text.includes("/parallel-cleanup"));
    assert.ok(!text.includes("chainDir"));
    assert.ok(!text.includes("{chain_dir}"));
  }
});

test("child supervisor instructions recommend decisions and forbid routine completion handoffs", () => {
  const publicIntercom = fs.readFileSync(path.join(root, "src/intercom-public/index.ts"), "utf8");
  const bridge = fs.readFileSync(path.join(root, "src/intercom/intercom-bridge.ts"), "utf8");
  for (const text of [publicIntercom, bridge]) {
    assert.match(text, /contact_supervisor/);
    assert.match(text, /need_decision/);
    assert.match(text, /progress_update/);
    assert.match(text, /routine completion handoffs/);
  }
});

test("shipped source excludes dead removed-feature implementations", () => {
  assert.equal(fs.existsSync(path.join(root, "src/slash")), false);
  assert.equal(fs.existsSync(path.join(root, "src/runs/foreground/chain-clarify.ts")), false);
  assert.equal(fs.existsSync(path.join(root, "src/runs/shared/worktree.ts")), false);
  assert.equal(fs.existsSync(path.join(root, "src/agents/agent-management.ts")), false);
  assert.equal(fs.existsSync(path.join(root, "src/agents/chain-serializer.ts")), false);
  assert.equal(fs.existsSync(path.join(root, "src/extension/doctor.ts")), false);

  const allowed = new Set([path.join(root, "src/extension/schemas.ts")]);
  const forbidden = [
    "registerCommand",
    "registerShortcut",
    "ChainClarify",
    "createChainDir",
    "buildChainInstructions",
    "progress.md",
    "worktree",
    "agent-management",
    "chain-serializer",
    "Subagents doctor report",
    "SUBAGENT_ACTIONS",
    "handleManagementAction",
    "buildDoctorReport",
    "agentScope",
  ];

  const offenders: string[] = [];
  for (const file of listTsFiles(path.join(root, "src"))) {
    if (allowed.has(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const token of forbidden) {
      if (text.includes(token)) offenders.push(`${path.relative(root, file)} contains ${token}`);
    }
  }

  assert.deepEqual(offenders, []);
});
