import { completeSimple, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

const LABEL_PROVIDER = "anthropic";
const LABEL_MODEL_ID = "claude-haiku-4-5";
const MAX_LABEL_TOKENS = 24;
const MAX_LABEL_WORDS = 5;
const FALLBACK_LABEL = "General followup";

export interface AiLabelGenerator {
	modelLabel: string;
	generate: (prompt: string, signal?: AbortSignal) => Promise<string | undefined>;
}

export interface AiLabelGeneratorResult {
	generator?: AiLabelGenerator;
	reason?: string;
}

function toSentenceCaseWord(word: string, isFirst: boolean): string {
	if (!word) return word;
	if (/^[A-Z0-9]{2,5}$/.test(word) || /\d/.test(word)) {
		return isFirst ? word[0]!.toUpperCase() + word.slice(1) : word;
	}
	const lower = word.toLowerCase();
	return isFirst ? lower[0]!.toUpperCase() + lower.slice(1) : lower;
}

function sanitizeLabel(text: string): string | undefined {
	const normalized = text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/[\r\n]+/g, " ")
		.replace(/["'`]+/g, " ")
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();

	if (!normalized) return FALLBACK_LABEL;

	const words = normalized.split(" ").filter(Boolean).slice(0, MAX_LABEL_WORDS);
	if (words.length < 2) return FALLBACK_LABEL;

	const label = words.map((word, index) => toSentenceCaseWord(word, index === 0)).join(" ").trim();
	return label || FALLBACK_LABEL;
}

function extractText(response: Awaited<ReturnType<typeof completeSimple>>): string | undefined {
	if (response.stopReason === "aborted" || response.stopReason === "error") return undefined;
	const text = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	if (!text) return undefined;
	return sanitizeLabel(text);
}

export async function createAiLabelGenerator(ctx: ExtensionContext): Promise<AiLabelGeneratorResult> {
	const model = ctx.modelRegistry.find(LABEL_PROVIDER, LABEL_MODEL_ID);
	if (!model) {
		return { reason: `model ${LABEL_PROVIDER}/${LABEL_MODEL_ID} unavailable` };
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		return { reason: auth.error || `auth unavailable for ${LABEL_PROVIDER}/${LABEL_MODEL_ID}` };
	}
	if (!auth.apiKey) {
		return { reason: `no API key for ${LABEL_PROVIDER}/${LABEL_MODEL_ID}` };
	}

	return {
		generator: {
			modelLabel: `${LABEL_PROVIDER}/${LABEL_MODEL_ID}`,
			generate: async (prompt: string, signal?: AbortSignal): Promise<string | undefined> => {
				const message: UserMessage = {
					role: "user",
					content: [{ type: "text", text: prompt }],
					timestamp: Date.now(),
				};

				const response = await completeSimple(model as never, { messages: [message] }, {
					apiKey: auth.apiKey,
					headers: auth.headers,
					signal,
					reasoning: "minimal",
					maxTokens: MAX_LABEL_TOKENS,
					temperature: 0.2,
				});

				return extractText(response);
			},
		},
	};
}
