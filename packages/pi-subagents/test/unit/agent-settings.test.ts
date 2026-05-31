import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverAgents } from "../../src/agents/agents.ts";

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

test("builtin agents expose explicit mutation guard policies", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-settings-"));
  const home = path.join(temp, "home");
  const project = path.join(temp, "project");
  fs.mkdirSync(project, { recursive: true });

  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const agents = new Map(discoverAgents(project, "both").agents.map((agent) => [agent.name, agent.mutationGuardPolicy]));
    assert.equal(agents.get("worker"), "auto");
    assert.equal(agents.get("delegate"), "auto");
    assert.equal(agents.get("reviewer"), "explicit");
    assert.equal(agents.get("oracle"), "never");
    assert.equal(agents.get("planner"), "never");
    assert.equal(agents.get("researcher"), "never");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("subagents.agents applies model/thinking/mutationGuard to discovered agents", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-settings-"));
  const home = path.join(temp, "home");
  const project = path.join(temp, "project");
  fs.mkdirSync(project, { recursive: true });

  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    writeJson(path.join(home, ".pi", "agent", "settings.json"), {
      subagents: {
        agents: {
          worker: {
            model: "mock/user-model",
            thinking: "low",
            mutationGuard: "always",
          },
        },
      },
    });

    const worker = discoverAgents(project, "both").agents.find((agent) => agent.name === "worker");
    assert.ok(worker);
    assert.equal(worker.model, "mock/user-model");
    assert.equal(worker.thinking, "low");
    assert.equal(worker.mutationGuardPolicy, "always");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("subagents.agents applies mutationGuard to custom agents", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-settings-"));
  const home = path.join(temp, "home");
  const project = path.join(temp, "project");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(home, ".agents"), { recursive: true });
  fs.writeFileSync(path.join(home, ".agents", "architect.md"), `---\nname: architect\ndescription: Review architecture\n---\n\nReview only.\n`);

  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    writeJson(path.join(home, ".pi", "agent", "settings.json"), {
      subagents: {
        agents: {
          architect: {
            mutationGuard: "never",
          },
        },
      },
    });

    const architect = discoverAgents(project, "both").agents.find((agent) => agent.name === "architect");
    assert.ok(architect);
    assert.equal(architect.mutationGuardPolicy, "never");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("agentOverrides can override builtin mutation guard policy", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-settings-"));
  const home = path.join(temp, "home");
  const project = path.join(temp, "project");
  fs.mkdirSync(project, { recursive: true });

  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    writeJson(path.join(home, ".pi", "agent", "settings.json"), {
      subagents: {
        agentOverrides: {
          oracle: {
            mutationGuard: "always",
          },
        },
      },
    });

    const oracle = discoverAgents(project, "both").agents.find((agent) => agent.name === "oracle");
    assert.ok(oracle);
    assert.equal(oracle.mutationGuardPolicy, "always");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("project subagents.agents overrides user subagents.agents", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-settings-"));
  const home = path.join(temp, "home");
  const project = path.join(temp, "project");
  fs.mkdirSync(path.join(project, ".pi"), { recursive: true });

  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    writeJson(path.join(home, ".pi", "agent", "settings.json"), {
      subagents: {
        agents: {
          worker: {
            model: "mock/user-model",
            thinking: "low",
            mutationGuard: "always",
          },
        },
      },
    });

    writeJson(path.join(project, ".pi", "settings.json"), {
      subagents: {
        agents: {
          worker: {
            model: "mock/project-model",
            thinking: "high",
            mutationGuard: "never",
          },
        },
      },
    });

    const worker = discoverAgents(project, "both").agents.find((agent) => agent.name === "worker");
    assert.ok(worker);
    assert.equal(worker.model, "mock/project-model");
    assert.equal(worker.thinking, "high");
    assert.equal(worker.mutationGuardPolicy, "never");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
