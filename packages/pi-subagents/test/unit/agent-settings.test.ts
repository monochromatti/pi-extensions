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

test("subagents.agents applies model/thinking to discovered agents", () => {
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
          },
        },
      },
    });

    const worker = discoverAgents(project, "both").agents.find((agent) => agent.name === "worker");
    assert.ok(worker);
    assert.equal(worker.model, "mock/user-model");
    assert.equal(worker.thinking, "low");
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
          },
        },
      },
    });

    const worker = discoverAgents(project, "both").agents.find((agent) => agent.name === "worker");
    assert.ok(worker);
    assert.equal(worker.model, "mock/project-model");
    assert.equal(worker.thinking, "high");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
