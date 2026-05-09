import * as fs from "node:fs";
import * as path from "node:path";
import type { AsyncStatus } from "../../shared/types.ts";

const statusCache = new Map<string, { mtime: number; status: AsyncStatus }>();

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNotFoundError(error: unknown): boolean {
	return typeof error === "object"
		&& error !== null
		&& "code" in error
		&& (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function readStatus(asyncDir: string): AsyncStatus | null {
	const statusPath = path.join(asyncDir, "status.json");

	let stat: fs.Stats;
	try {
		stat = fs.statSync(statusPath);
	} catch (error) {
		if (isNotFoundError(error)) return null;
		throw new Error(`Failed to inspect async status file '${statusPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}

	const cached = statusCache.get(statusPath);
	if (cached && cached.mtime === stat.mtimeMs) {
		return cached.status;
	}

	let content: string;
	try {
		content = fs.readFileSync(statusPath, "utf-8");
	} catch (error) {
		if (isNotFoundError(error)) return null;
		throw new Error(`Failed to read async status file '${statusPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}

	let status: AsyncStatus;
	try {
		status = JSON.parse(content) as AsyncStatus;
	} catch (error) {
		throw new Error(`Failed to parse async status file '${statusPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}

	statusCache.set(statusPath, { mtime: stat.mtimeMs, status });
	if (statusCache.size > 50) {
		const firstKey = statusCache.keys().next().value;
		if (firstKey) statusCache.delete(firstKey);
	}
	return status;
}
