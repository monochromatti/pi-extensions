import { createHash } from "node:crypto";
import { dirname, join } from "path";
import { homedir, tmpdir } from "os";

function sanitizePipeSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "default";
}

const MAX_UNIX_SOCKET_PATH_LENGTH = 100;

function shortSocketPath(homeDir: string, tempDir: string = tmpdir()): string {
  const hash = createHash("sha1").update(homeDir).digest("hex").slice(0, 16);
  return join(tempDir, `pi-intercom-${hash}.sock`);
}

export function getBrokerSocketPath(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = homedir(),
  tempDir: string = tmpdir(),
): string {
  if (platform === "win32") {
    return `\\\\.\\pipe\\pi-intercom-${sanitizePipeSegment(homeDir)}`;
  }

  const defaultPath = join(homeDir, ".pi/agent/intercom/broker.sock");
  return defaultPath.length < MAX_UNIX_SOCKET_PATH_LENGTH ? defaultPath : shortSocketPath(homeDir, tempDir);
}

export function getBrokerSocketDir(socketPath: string): string {
  return dirname(socketPath);
}
