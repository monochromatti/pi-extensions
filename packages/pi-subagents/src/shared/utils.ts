/**
 * General utility functions for subagent extension
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { formatToolCall } from "./formatters.ts";
import type { AgentProgress, Details, SingleResult, ToolCallSummary } from "./types.ts";

// ============================================================================
// File System Utilities
// ============================================================================

export function resolveChildCwd(baseCwd: string, childCwd: string | undefined): string {
	if (!childCwd) return baseCwd;
	return path.isAbsolute(childCwd) ? childCwd : path.resolve(baseCwd, childCwd);
}

const outputTailCache = new Map<string, { mtime: number; size: number; lines: string[] }>();

/**
 * Get last N lines from output file (with mtime/size cache)
 */
function getOutputTail(outputFile: string | undefined, maxLines: number = 3): string[] {
	if (!outputFile) return [];
	let fd: number | null = null;
	try {
		const stat = fs.statSync(outputFile);
		if (stat.size === 0) return [];

		const cached = outputTailCache.get(outputFile);
		if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
			return cached.lines;
		}

		const tailBytes = 4096;
		const start = Math.max(0, stat.size - tailBytes);
		fd = fs.openSync(outputFile, "r");
		const buffer = Buffer.alloc(Math.min(tailBytes, stat.size));
		fs.readSync(fd, buffer, 0, buffer.length, start);
		const content = buffer.toString("utf-8");
		const allLines = content.split("\n").filter((l) => l.trim());
		const lines = allLines.slice(-maxLines).map((l) => l.slice(0, 120) + (l.length > 120 ? "..." : ""));

		outputTailCache.set(outputFile, { mtime: stat.mtimeMs, size: stat.size, lines });
		if (outputTailCache.size > 20) {
			const firstKey = outputTailCache.keys().next().value;
			if (firstKey) outputTailCache.delete(firstKey);
		}

		return lines;
	} catch {
		return [];
	} finally {
		if (fd !== null) {
			try {
				fs.closeSync(fd);
			} catch {
				// best effort close
			}
		}
	}
}

/**
 * Get human-readable last activity time for file
 */
export function getLastActivity(outputFile: string | undefined): string {
	if (!outputFile) return "";
	try {
		const stat = fs.statSync(outputFile);
		const ago = Date.now() - stat.mtimeMs;
		if (ago < 1000) return "active now";
		if (ago < 60000) return `active ${Math.floor(ago / 1000)}s ago`;
		return `active ${Math.floor(ago / 60000)}m ago`;
	} catch {
		return "";
	}
}

/**
 * Find latest session file in directory
 */
export function findLatestSessionFile(sessionDir: string): string | null {
	if (!fs.existsSync(sessionDir)) return null;
	const files = fs.readdirSync(sessionDir)
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => {
			const filePath = path.join(sessionDir, f);
			return {
				path: filePath,
				mtime: fs.statSync(filePath).mtimeMs,
			};
		})
		.sort((a, b) => b.mtime - a.mtime);
	return files.length > 0 ? files[0].path : null;
}

// ============================================================================
// Result Compaction
// ============================================================================

function compactCompletedProgress(progress: AgentProgress): AgentProgress {
	if (progress.status === "running") return progress;
	return {
		index: progress.index,
		agent: progress.agent,
		status: progress.status,
		activityState: progress.activityState,
		task: progress.task,
		skills: progress.skills,
		toolCount: progress.toolCount,
		tokens: progress.tokens,
		durationMs: progress.durationMs,
		error: progress.error,
		failedTool: progress.failedTool,
		recentTools: [],
		recentOutput: [],
	};
}

function extractToolCallSummaries(messages: Message[] | undefined): ToolCallSummary[] {
	if (!messages?.length) return [];
	const summaries: ToolCallSummary[] = [];
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type !== "toolCall") continue;
			const args = typeof part.arguments === "object" && part.arguments !== null && !Array.isArray(part.arguments)
				? part.arguments
				: {};
			summaries.push({
				text: formatToolCall(part.name, args),
				expandedText: formatToolCall(part.name, args, true),
			});
		}
	}
	return summaries;
}

export function compactForegroundResult(result: SingleResult): SingleResult {
	if (result.progress?.status === "running") return result;
	const toolCalls = result.toolCalls?.length ? result.toolCalls : extractToolCallSummaries(result.messages);
	return {
		...result,
		messages: undefined,
		progress: undefined,
		toolCalls: toolCalls.length ? toolCalls : undefined,
	};
}

export function compactForegroundDetails(details: Details): Details {
	return {
		...details,
		results: details.results.map(compactForegroundResult),
		progress: details.progress
			? details.progress.map(compactCompletedProgress)
			: undefined,
	};
}

// compatibility re-exports after split
export { readStatus } from "../runs/background/status-store.ts";
export { detectSubagentError } from "./error-detection.ts";
export { extractToolArgsPreview } from "./tool-preview.ts";
export { extractTextFromContent, getDisplayItems, getFinalOutput, getSingleResultOutput } from "./messages.ts";

// ============================================================================
// Concurrency Utilities
// ============================================================================

export { mapConcurrent } from "../runs/shared/parallel-utils.ts";
