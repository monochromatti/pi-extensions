import { createHash } from "crypto";
import { realpathSync } from "fs";
import path from "path";

export interface IntercomNamespaceResult {
  namespace: string;
  canonicalPath: string;
  degraded: boolean;
  diagnostic?: string;
}

function hashNamespace(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function deriveIntercomNamespace(input: { cwd: string; workspaceRoot?: string }): IntercomNamespaceResult {
  const source = input.workspaceRoot?.trim() || input.cwd;
  const normalized = path.resolve(source);
  try {
    const canonicalPath = realpathSync.native(normalized);
    return {
      namespace: hashNamespace(canonicalPath),
      canonicalPath,
      degraded: false,
    };
  } catch (error) {
    const canonicalPath = normalized;
    return {
      namespace: hashNamespace(canonicalPath),
      canonicalPath,
      degraded: true,
      diagnostic: `namespace-realpath-failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
