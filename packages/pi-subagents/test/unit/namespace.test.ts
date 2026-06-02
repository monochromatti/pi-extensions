import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deriveIntercomNamespace } from "../../src/intercom-public/namespace.ts";

function expectedNamespace(canonicalPath: string): string {
  return createHash("sha256").update(canonicalPath).digest("hex").slice(0, 16);
}

test("namespace is sha256(realpath(workspaceRoot ?? cwd)).slice(0, 16)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-intercom-namespace-"));
  try {
    const link = `${dir}-link`;
    symlinkSync(dir, link, "dir");
    const result = deriveIntercomNamespace({ cwd: link });
    assert.equal(result.degraded, false);
    assert.equal(result.canonicalPath, dir);
    assert.equal(result.namespace, expectedNamespace(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}-link`, { recursive: true, force: true });
  }
});

test("namespace falls back to normalized cwd with degraded diagnostic when realpath fails", () => {
  const missing = path.join(tmpdir(), "pi-intercom-missing", `${Date.now()}`);
  const result = deriveIntercomNamespace({ cwd: missing });
  assert.equal(result.degraded, true);
  assert.equal(result.canonicalPath, path.resolve(missing));
  assert.equal(result.namespace, expectedNamespace(path.resolve(missing)));
  assert.match(result.diagnostic ?? "", /namespace-realpath-failed/);
});
