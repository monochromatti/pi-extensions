import type { AgentMessage } from "@earendil-works/pi-agent-core";

interface UsageLike {
	cost?: number | { total?: unknown };
}

function costFromUsage(value: unknown): number {
	if (!value || typeof value !== "object") return 0;
	const cost = (value as UsageLike).cost;
	if (typeof cost === "number" && Number.isFinite(cost)) return cost;
	if (cost && typeof cost === "object" && typeof cost.total === "number" && Number.isFinite(cost.total)) {
		return cost.total;
	}
	return 0;
}

function costFromChild(value: unknown): number {
	if (!value || typeof value !== "object") return 0;
	const child = value as {
		usage?: unknown;
		modelAttempts?: unknown;
	};
	// Foreground results expose aggregate usage. Async result files expose attempts.
	if (child.usage) return costFromUsage(child.usage);
	if (Array.isArray(child.modelAttempts)) {
		return child.modelAttempts.reduce((total, attempt) => {
			if (!attempt || typeof attempt !== "object") return total;
			return total + costFromUsage((attempt as { usage?: unknown }).usage);
		}, 0);
	}
	return 0;
}

/** Extract child model spend from foreground details or async result payload. */
export function subagentCost(value: unknown): number {
	if (!value || typeof value !== "object") return 0;
	const payload = value as { results?: unknown; usage?: unknown; modelAttempts?: unknown };
	if (Array.isArray(payload.results) && payload.results.length > 0) {
		return payload.results.reduce((total, result) => total + costFromChild(result), 0);
	}
	if (payload.usage) return costFromUsage(payload.usage);
	if (Array.isArray(payload.modelAttempts)) {
		return payload.modelAttempts.reduce((total, attempt) => {
			if (!attempt || typeof attempt !== "object") return total;
			return total + costFromUsage((attempt as { usage?: unknown }).usage);
		}, 0);
	}
	return 0;
}

/** Add child spend to assistant usage so host session cost trackers include it. */
export function addSubagentCostToAssistantMessage(message: AgentMessage, cost: number): AgentMessage {
	if (message.role !== "assistant" || !Number.isFinite(cost) || cost <= 0) return message;
	const assistant = message as AgentMessage & {
		usage?: { cost?: number | { total?: number }; [key: string]: unknown };
	};
	const usage = assistant.usage;
	if (!usage) return message;
	const previous = typeof usage.cost === "number"
		? usage.cost
		: usage.cost && typeof usage.cost === "object" && typeof usage.cost.total === "number"
			? usage.cost.total
			: 0;
	const costValue = typeof usage.cost === "object" && usage.cost !== null ? usage.cost : {};
	return {
		...message,
		usage: {
			...usage,
			cost: { ...costValue, total: previous + cost },
		},
	} as AgentMessage;
}
