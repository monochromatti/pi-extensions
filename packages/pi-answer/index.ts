/**
 * Q&A extraction hook - extracts questions from assistant responses
 *
 * Custom interactive TUI for answering questions.
 *
 * Demonstrates the "prompt generator" pattern with custom TUI:
 * 1. /answer command gets the last assistant message
 * 2. Shows a spinner while extracting questions as structured JSON
 * 3. Presents an interactive TUI to navigate and answer questions
 * 4. Submits the compiled answers when done
 */

import { complete, type Api, type Model, type UserMessage } from "@mariozechner/pi-ai";
import {
	BorderedLoader,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import fs from "node:fs/promises";
import path from "node:path";
import {
	type Component,
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

// Structured output format for question extraction
interface ExtractedOption {
	label?: string;
	text: string;
	description?: string;
}

interface ExtractedQuestion {
	id?: string;
	header?: string;
	question: string;
	context?: string;
	type: "freeform" | "single" | "multi";
	options?: ExtractedOption[];
}

interface ExtractionResult {
	questions: ExtractedQuestion[];
}

interface AnswerSettings {
	systemPrompt?: string;
	extractionModels?: Array<{ provider: string; id: string }>;
	drafts?: { enabled?: boolean; autosaveMs?: number; promptOnRestore?: boolean };
}

interface AnswerDraft {
	version: number;
	sourceEntryId: string;
	questions: ExtractedQuestion[];
	answers: string[];
	selectedOptions: number[][];
	state: "draft" | "cleared";
	updatedAt: number;
}

type ExtractionOutcome =
	| { status: "ok"; result: ExtractionResult }
	| { status: "cancelled" }
	| { status: "error"; message: string };

const EXTRACTION_MAX_ATTEMPTS = 3;

const SYSTEM_PROMPT = `You are a question extractor. Given text from a conversation, extract any questions that need answering.

Output a JSON object with this structure:
{
  "questions": [
    {
      "id": "stable_snake_case_id",
      "header": "Optional short display title",
      "question": "The question text",
      "context": "Optional context that helps answer the question",
      "type": "freeform",
      "options": [
        {
          "label": "A",
          "text": "First option",
          "description": "Optional short explanation"
        }
      ]
    }
  ]
}

Rules:
- Extract all questions that require user input
- Keep questions in the order they appeared
- Include stable snake_case \`id\` values when possible
- Include short \`header\` values when useful for display; omit when question alone is clear
- Be concise with question text
- Include context only when it provides essential information for answering
- Decide each question's \`type\` independently:
  - \`freeform\`: answer should be typed as freeform text; omit \`options\`
  - \`single\`: user should choose exactly one explicit option
  - \`multi\`: user may choose multiple explicit options
- Use \`single\` or \`multi\` only when the assistant clearly provides explicit alternatives (for example A/B/C, numbered choices, checklists, or mutually exclusive choices)
- Only include \`options\` for \`single\` and \`multi\` questions, and only when the original text clearly presents real choices; never invent options
- Option \`text\` should fully represent the answer; include \`description\` only for extra explanation
- Prefer \`single\` for mutually exclusive alternatives like “TypeScript or JavaScript?”; prefer \`multi\` for “choose any”, “which of these apply”, checklists, or additive options
- If no questions are found, return {"questions": []}

Example output:
{
  "questions": [
    {
      "question": "What is your preferred database?",
	  "id": "preferred_database",
	  "header": "Database",
      "type": "freeform",
      "context": "We can only configure MySQL and PostgreSQL because of what is implemented."
    },
    {
	    "question": "Should we use TypeScript or JavaScript?",
	    "type": "single",
	    "options": [
	      {
	        "label": "A",
	        "text": "TypeScript"
	      },
	      {
	        "label": "B",
	        "text": "JavaScript"
	      }
	    ]
    }
  ]
}`;

const OPENAI_MINI_MODEL_ID = "gpt-5.4-mini";
const HAIKU_MODEL_ID = "claude-haiku-4-5";

const REPAIR_SYSTEM_PROMPT = `You repair JSON.

You will receive model output that was supposed to be valid JSON with this exact shape:
{
  "questions": [
    {
      "question": "The question text",
      "context": "Optional context that helps answer the question",
      "type": "freeform",
      "options": [
        {
          "label": "A",
          "text": "First option"
        }
      ]
    }
  ]
}

Return ONLY valid JSON.
- No markdown
- No prose
- No explanation
- Preserve the original meaning
- If the original text does not contain any valid questions, return {"questions": []}`;

function fallbackOptionLabel(index: number): string {
	return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

function normalizeOptionLabel(label: string | undefined, index: number, used: Set<string>): string {
	const trimmed = (label || "").trim();
	const simplified = trimmed.replace(/[\s.)\]:-]+$/g, "");
	const rawCandidate = simplified || fallbackOptionLabel(index);
	const candidate = /^[a-z]$/i.test(rawCandidate) ? rawCandidate.toUpperCase() : rawCandidate;
	const normalizedKey = candidate.toLowerCase();
	if (used.has(normalizedKey)) {
		const fallback = fallbackOptionLabel(index);
		used.add(fallback.toLowerCase());
		return fallback;
	}
	used.add(normalizedKey);
	return candidate;
}

function sanitizeOptions(options: unknown): ExtractedOption[] | undefined {
	if (!Array.isArray(options) || options.length === 0) {
		return undefined;
	}

	const usedLabels = new Set<string>();
	const sanitized = options
		.map((option, index): ExtractedOption | null => {
			if (typeof option === "string") {
				const text = option.trim();
				if (!text) return null;
				return {
					label: normalizeOptionLabel(undefined, index, usedLabels),
					text,
				};
			}

			if (!option || typeof option !== "object") {
				return null;
			}

			const optionLike = option as { label?: unknown; text?: unknown; description?: unknown };
			if (typeof optionLike.text !== "string") {
				return null;
			}

			const text = optionLike.text.trim();
			if (!text) {
				return null;
			}

			return {
				label: normalizeOptionLabel(
					typeof optionLike.label === "string" ? optionLike.label : undefined,
					index,
					usedLabels,
				),
				text,
				description: typeof optionLike.description === "string" && optionLike.description.trim() ? optionLike.description.trim() : undefined,
			};
		})
		.filter((option): option is ExtractedOption => option !== null);

	return sanitized.length > 0 ? sanitized : undefined;
}

function sanitizeQuestionType(type: unknown, options: ExtractedOption[] | undefined): ExtractedQuestion["type"] {
	if (type === "single" && options?.length) return "single";
	if (type === "multi" && options?.length) return "multi";
	if (type !== "freeform" && options?.length) return "multi";
	return "freeform";
}

function normalizeIdentifier(raw: unknown, fallback: string, used: Set<string>): string {
	const base = (typeof raw === "string" ? raw : fallback)
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");
	let id = base || "question";
	let suffix = 2;
	while (used.has(id)) {
		id = `${base || "question"}_${suffix++}`;
	}
	used.add(id);
	return id;
}

function sanitizeExtractionResult(value: unknown): ExtractionResult | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	const candidate = value as { questions?: unknown };
	if (!Array.isArray(candidate.questions)) {
		return null;
	}

	const questions = candidate.questions
		.map((question): ExtractedQuestion | null => {
			if (!question || typeof question !== "object") {
				return null;
			}

			const questionLike = question as {
				id?: unknown;
				header?: unknown;
				question?: unknown;
				context?: unknown;
				type?: unknown;
				options?: unknown;
			};

			if (typeof questionLike.question !== "string") {
				return null;
			}

			const normalizedQuestion = questionLike.question.trim();
			if (!normalizedQuestion) {
				return null;
			}

			const normalizedContext =
				typeof questionLike.context === "string" && questionLike.context.trim().length > 0
					? questionLike.context.trim()
					: undefined;
			const options = sanitizeOptions(questionLike.options);
			const type = sanitizeQuestionType(questionLike.type, options);

			return {
				id: typeof questionLike.id === "string" ? questionLike.id : undefined,
				header: typeof questionLike.header === "string" && questionLike.header.trim() ? questionLike.header.trim() : undefined,
				question: normalizedQuestion,
				context: normalizedContext,
				type,
				options: type === "freeform" ? undefined : options,
			};
		})
		.filter((question): question is ExtractedQuestion => question !== null);

	const usedIds = new Set<string>();
	for (const question of questions) {
		question.id = normalizeIdentifier(question.id, question.question, usedIds);
	}

	return { questions };
}

/**
 * Prefer GPT-5.4 mini for question extraction when available, otherwise fallback to haiku or the current model.
 */
async function selectExtractionModels(currentModel: Model<Api>, modelRegistry: ModelRegistry): Promise<Model<Api>[]> {
	const models: Model<Api>[] = [currentModel];
	const seen = new Set<string>([`${currentModel.provider}:${currentModel.id}`]);

	const maybeAdd = async (provider: string, id: string) => {
		const model = modelRegistry.find(provider, id);
		if (!model) return;
		const key = `${model.provider}:${model.id}`;
		if (seen.has(key)) return;
		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return;
		seen.add(key);
		models.push(model);
	};

	await maybeAdd("openai-codex", OPENAI_MINI_MODEL_ID);
	await maybeAdd("anthropic", HAIKU_MODEL_ID);

	return models;
}

async function readJson(pathname: string): Promise<Record<string, unknown> | null> {
	try {
		return JSON.parse(await fs.readFile(pathname, "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

async function loadAnswerSettings(cwd: string): Promise<AnswerSettings> {
	const [globalSettings, projectSettings] = await Promise.all([
		readJson(path.join(getAgentDir(), "settings.json")),
		readJson(path.join(cwd, ".pi", "settings.json")),
	]);
	const globalAnswer = (globalSettings?.answer ?? {}) as AnswerSettings;
	const projectAnswer = (projectSettings?.answer ?? {}) as AnswerSettings;
	return {
		systemPrompt: projectAnswer.systemPrompt ?? globalAnswer.systemPrompt,
		extractionModels: projectAnswer.extractionModels ?? globalAnswer.extractionModels,
		drafts: { ...globalAnswer.drafts, ...projectAnswer.drafts },
	};
}

async function selectConfiguredExtractionModels(currentModel: Model<Api>, modelRegistry: ModelRegistry, settings: AnswerSettings): Promise<Model<Api>[]> {
	if (!settings.extractionModels?.length) return selectExtractionModels(currentModel, modelRegistry);
	const models: Model<Api>[] = [];
	const seen = new Set<string>();
	for (const preference of settings.extractionModels) {
		const model = modelRegistry.find(preference.provider, preference.id);
		if (!model) continue;
		const key = `${model.provider}:${model.id}`;
		if (seen.has(key)) continue;
		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) continue;
		seen.add(key);
		models.push(model);
	}
	return models.length ? models : selectExtractionModels(currentModel, modelRegistry);
}

/**
 * Parse the JSON response from the LLM
 */
function tryParseExtractionResult(text: string): ExtractionResult | null {
	try {
		const parsed = JSON.parse(text);
		return sanitizeExtractionResult(parsed);
	} catch {
		return null;
	}
}

function extractBalancedJsonObject(text: string): string | null {
	let start = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];

		if (start === -1) {
			if (ch === "{") {
				start = i;
				depth = 1;
			}
			continue;
		}

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === '"') {
				inString = false;
			}
			continue;
		}

		if (ch === '"') {
			inString = true;
			continue;
		}

		if (ch === "{") {
			depth++;
			continue;
		}

		if (ch === "}") {
			depth--;
			if (depth === 0) {
				return text.slice(start, i + 1);
			}
		}
	}

	return null;
}

function parseExtractionResult(text: string): ExtractionResult | null {
	const candidates: string[] = [];
	const trimmed = text.trim();
	if (trimmed) {
		candidates.push(trimmed);
	}

	const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (jsonMatch?.[1]) {
		candidates.push(jsonMatch[1].trim());
	}

	const balanced = extractBalancedJsonObject(text);
	if (balanced) {
		candidates.push(balanced.trim());
	}

	for (const candidate of candidates) {
		const parsed = tryParseExtractionResult(candidate);
		if (parsed) {
			return parsed;
		}
	}

	return null;
}

async function completeForJson(
	model: Model<Api>,
	modelRegistry: ModelRegistry,
	messages: UserMessage[],
	systemPrompt: string,
	signal: AbortSignal | undefined,
): Promise<string> {
	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		throw new Error(auth.error);
	}

	const response = await complete(
		model,
		{ systemPrompt, messages },
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			signal,
			reasoning: "low",
			temperature: 0,
		},
	);

	if (response.stopReason === "aborted") {
		throw new Error("aborted");
	}

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

async function extractQuestionsWithModel(
	models: Model<Api>[],
	modelRegistry: ModelRegistry,
	lastAssistantText: string,
	conversationContext: string,
	systemPrompt: string,
	signal: AbortSignal | undefined,
): Promise<ExtractionResult> {
	let lastResponseText = "";
	let lastModelId = models[0]?.id || "unknown";

	for (const model of models) {
		lastModelId = model.id;
		lastResponseText = "";

		for (let attempt = 1; attempt <= EXTRACTION_MAX_ATTEMPTS; attempt++) {
			const extractionInput = conversationContext
				? "Use conversation context only to clarify wording and options. Extract questions ONLY from the latest assistant message.\n\nConversation context:\n" +
					conversationContext +
					"\n\nLatest assistant message:\n" +
					lastAssistantText
				: "Latest assistant message:\n" + lastAssistantText;

			const responseText =
				attempt === 1
					? await completeForJson(
							model,
							modelRegistry,
							[
								{
									role: "user",
									content: [
										{
											type: "text",
											text:
												"Extract all questions that require an answer from the latest assistant message. Return ONLY valid JSON. No markdown fences. No prose.\n\n" +
												extractionInput,
										},
									],
									timestamp: Date.now(),
								},
							],
							systemPrompt +
								"\n\nIMPORTANT: Return ONLY a valid JSON object. Do not wrap it in markdown. Do not include commentary. Extract questions ONLY from the latest assistant message; prior context is only for disambiguation.",
							signal,
						)
					: await completeForJson(
							model,
							modelRegistry,
							[
								{
									role: "user",
									content: [
										{
											type: "text",
											text:
												"The previous output was invalid or empty. Try again and return ONLY valid JSON matching the schema. Extract questions ONLY from the latest assistant message.\n\n" +
												extractionInput +
												"\n\nPrevious invalid output:\n" +
												(lastResponseText || "(empty)"),
										},
									],
									timestamp: Date.now(),
								},
							],
							REPAIR_SYSTEM_PROMPT,
							signal,
						);

			lastResponseText = responseText;
			const parsed = parseExtractionResult(responseText);
			if (parsed) {
				return parsed;
			}
		}
	}

	throw new Error(
		`Failed to parse extracted questions from model output after ${EXTRACTION_MAX_ATTEMPTS} attempts on ${lastModelId}:\n${lastResponseText}`,
	);
}

/**
 * Interactive Q&A component for answering extracted questions
 */
class QnAComponent implements Component {
	private questions: ExtractedQuestion[];
	private answers: string[];
	private selectedOptions: Array<Set<number>>;
	private currentIndex = 0;
	private editor: Editor;
	private tui: TUI;
	private onDone: (result: string | null) => void;
	private onDraftChange?: (answers: string[], selectedOptions: Array<Set<number>>) => void;
	private showingConfirmation = false;

	// Cache
	private cachedWidth?: number;
	private cachedLines?: string[];

	// Colors - using proper reset sequences
	private dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
	private bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
	private cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
	private green = (s: string) => `\x1b[32m${s}\x1b[0m`;
	private yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
	private gray = (s: string) => `\x1b[90m${s}\x1b[0m`;

	constructor(questions: ExtractedQuestion[], tui: TUI, onDone: (result: string | null) => void, initialDraft?: Pick<AnswerDraft, "answers" | "selectedOptions">, onDraftChange?: (answers: string[], selectedOptions: Array<Set<number>>) => void) {
		this.questions = questions;
		this.answers = questions.map((_, index) => initialDraft?.answers[index] ?? "");
		this.selectedOptions = questions.map((_, index) => new Set<number>(initialDraft?.selectedOptions[index] ?? []));
		this.tui = tui;
		this.onDone = onDone;
		this.onDraftChange = onDraftChange;

		// Create a minimal theme for the editor
		const editorTheme: EditorTheme = {
			borderColor: this.dim,
			selectList: {
				selectedPrefix: this.cyan,
				selectedText: (s: string) => `\x1b[44m${s}\x1b[0m`,
				description: this.gray,
				scrollInfo: this.dim,
				noMatch: this.dim,
			},
		};

		this.editor = new Editor(tui, editorTheme);
		this.editor.setText(this.answers[0] || "");
		// Disable the editor's built-in submit (which clears the editor)
		// We'll handle Enter ourselves to preserve the text
		this.editor.disableSubmit = true;
		this.editor.onChange = () => {
			this.invalidate();
			this.tui.requestRender();
		};
	}

	private saveCurrentAnswer(): void {
		this.answers[this.currentIndex] = this.editor.getText();
		this.onDraftChange?.(this.answers.slice(), this.selectedOptions.map((set) => new Set(set)));
	}

	private navigateTo(index: number): void {
		if (index < 0 || index >= this.questions.length) return;
		this.saveCurrentAnswer();
		this.currentIndex = index;
		this.editor.setText(this.answers[index] || "");
		this.invalidate();
	}

	private formatOption(option: ExtractedOption): string {
		const label = option.label ? `${option.label}) ${option.text}` : option.text;
		return option.description ? `${label} — ${option.description}` : label;
	}

	private formatSelectedOption(option: ExtractedOption): string {
		return option.label ? `${option.label}) ${option.text}` : option.text;
	}

	private optionShortcutHint(question: ExtractedQuestion): string {
		const labels = (question.options || [])
			.map((option) => option.label?.trim())
			.filter((label): label is string => !!label);
		if (labels.length === 0) {
			return "option";
		}
		if (labels.length <= 4) {
			return labels.join("/");
		}
		return `${labels.slice(0, 4).join("/")}/...`;
	}

	private trySelectOptionFromInput(data: string): boolean {
		const question = this.questions[this.currentIndex];
		const options = question.options;
		if (!options?.length) {
			return false;
		}

		if (question.type === "freeform" || data.length !== 1) {
			return false;
		}

		const numericIndex = /^[1-9]$/.test(data) ? Number(data) - 1 : -1;
		const matchedIndex = numericIndex >= 0 && numericIndex < options.length
			? numericIndex
			: options.findIndex((option) => option.label?.toLowerCase() === data.toLowerCase());
		if (matchedIndex === -1) {
			return false;
		}

		const selected = this.selectedOptions[this.currentIndex];
		if (selected.has(matchedIndex)) {
			selected.delete(matchedIndex);
		} else {
			if (question.type === "single") {
				selected.clear();
			}
			selected.add(matchedIndex);
		}
		this.onDraftChange?.(this.answers.slice(), this.selectedOptions.map((set) => new Set(set)));
		this.invalidate();
		this.tui.requestRender();
		return true;
	}

	private moveOptionSelection(delta: number): boolean {
		const question = this.questions[this.currentIndex];
		const options = question.options;
		if (question.type === "freeform" || !options?.length || this.editor.getText() !== "") return false;
		const selected = this.selectedOptions[this.currentIndex];
		const current = selected.size ? [...selected].sort((a, b) => a - b)[0] : (delta > 0 ? -1 : options.length);
		const next = Math.max(0, Math.min(options.length - 1, current + delta));
		if (question.type === "single") selected.clear();
		selected.add(next);
		this.onDraftChange?.(this.answers.slice(), this.selectedOptions.map((set) => new Set(set)));
		this.invalidate();
		this.tui.requestRender();
		return true;
	}

	private submit(): void {
		this.saveCurrentAnswer();

		// Build the response text
		const parts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			const q = this.questions[i];
			const a = this.answers[i]?.trim() || "";
			const selectedOptionIndexes = [...this.selectedOptions[i]].sort((a, b) => a - b);
			if (!a && selectedOptionIndexes.length === 0) continue;
			parts.push(`Q: ${q.question}`);
			if (q.context) {
				parts.push(`> ${q.context}`);
			}
			if (q.options?.length && selectedOptionIndexes.length > 0) {
				parts.push(selectedOptionIndexes.length === 1 ? "Choice:" : "Choices:");
				for (const selectedOptionIndex of selectedOptionIndexes) {
					const selectedOption = q.options[selectedOptionIndex];
					if (selectedOption) {
						parts.push(`- ${this.formatSelectedOption(selectedOption)}`);
					}
				}
			}
			if (a) {
				parts.push(`A: ${a}`);
			}
			parts.push("");
		}

		this.onDone(parts.join("\n").trim());
	}

	private cancel(): void {
		this.saveCurrentAnswer();
		this.onDone(null);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		// Handle confirmation dialog
		if (this.showingConfirmation) {
			if (matchesKey(data, Key.enter) || data.toLowerCase() === "y") {
				this.submit();
				return;
			}
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "n") {
				this.showingConfirmation = false;
				this.invalidate();
				this.tui.requestRender();
				return;
			}
			return;
		}

		// Global navigation and commands
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.cancel();
			return;
		}

		// Tab / Shift+Tab for navigation
		if (matchesKey(data, Key.tab)) {
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			if (this.currentIndex > 0) {
				this.navigateTo(this.currentIndex - 1);
				this.tui.requestRender();
			}
			return;
		}

		// Arrow up/down for question navigation when editor is empty or no freeform editor is active
		// (Editor handles its own cursor navigation when there's content)
		if (matchesKey(data, Key.up) && this.moveOptionSelection(-1)) return;
		if (matchesKey(data, Key.down) && this.moveOptionSelection(1)) return;

		if (matchesKey(data, Key.up) && (this.questions[this.currentIndex].type !== "freeform" || this.editor.getText() === "")) {
			if (this.currentIndex > 0) {
				this.navigateTo(this.currentIndex - 1);
				this.tui.requestRender();
				return;
			}
		}
		if (matchesKey(data, Key.down) && (this.questions[this.currentIndex].type !== "freeform" || this.editor.getText() === "")) {
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
				this.tui.requestRender();
				return;
			}
		}

		// Handle Enter ourselves (editor's submit is disabled)
		// Plain Enter moves to next question or shows confirmation on last question
		// Shift+Enter adds a newline (handled by editor)
		if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
			this.saveCurrentAnswer();
			if (this.currentIndex < this.questions.length - 1) {
				this.navigateTo(this.currentIndex + 1);
			} else {
				// On last question - show confirmation
				this.showingConfirmation = true;
			}
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (this.trySelectOptionFromInput(data)) {
			return;
		}

		// Pass to editor
		this.editor.handleInput(data);
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const boxWidth = Math.min(width - 4, 120); // Allow wider box
		const contentWidth = boxWidth - 4; // 2 chars padding on each side

		// Helper to create horizontal lines (dim the whole thing at once)
		const horizontalLine = (count: number) => "─".repeat(count);

		// Helper to create a box line
		const boxLine = (content: string, leftPad: number = 2): string => {
			const paddedContent = " ".repeat(leftPad) + content;
			const contentLen = visibleWidth(paddedContent);
			const rightPad = Math.max(0, boxWidth - contentLen - 2);
			return this.dim("│") + paddedContent + " ".repeat(rightPad) + this.dim("│");
		};

		const emptyBoxLine = (): string => {
			return this.dim("│") + " ".repeat(boxWidth - 2) + this.dim("│");
		};

		const padToWidth = (line: string): string => {
			const len = visibleWidth(line);
			return line + " ".repeat(Math.max(0, width - len));
		};

		// Title
		lines.push(padToWidth(this.dim("╭" + horizontalLine(boxWidth - 2) + "╮")));
		const title = `${this.bold(this.cyan("Questions"))} ${this.dim(`(${this.currentIndex + 1}/${this.questions.length})`)}`;
		lines.push(padToWidth(boxLine(title)));
		lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));

		// Progress indicator
		const progressParts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			const answered = (this.answers[i]?.trim() || "").length > 0 || this.selectedOptions[i].size > 0;
			const current = i === this.currentIndex;
			if (current) {
				progressParts.push(this.cyan("●"));
			} else if (answered) {
				progressParts.push(this.green("●"));
			} else {
				progressParts.push(this.dim("○"));
			}
		}
		lines.push(padToWidth(boxLine(progressParts.join(" "))));
		lines.push(padToWidth(emptyBoxLine()));

		// Current question
		const q = this.questions[this.currentIndex];
		if (q.header) {
			for (const line of wrapTextWithAnsi(this.bold(this.cyan(q.header)), contentWidth)) {
				lines.push(padToWidth(boxLine(line)));
			}
		}
		const questionText = `${this.bold("Q:")} ${q.question}`;
		const wrappedQuestion = wrapTextWithAnsi(questionText, contentWidth);
		for (const line of wrappedQuestion) {
			lines.push(padToWidth(boxLine(line)));
		}

		// Context if present
		if (q.context) {
			lines.push(padToWidth(emptyBoxLine()));
			const contextText = this.gray(`> ${q.context}`);
			const wrappedContext = wrapTextWithAnsi(contextText, contentWidth - 2);
			for (const line of wrappedContext) {
				lines.push(padToWidth(boxLine(line)));
			}
		}

		if (q.options?.length) {
			lines.push(padToWidth(emptyBoxLine()));
			const selectedOptionIndexes = this.selectedOptions[this.currentIndex];
			const optionHint = this.dim(q.type === "single"
				? "Options (press label to choose one; type below for Other)"
				: "Options (press labels to toggle multiple; type below for Other)");
			for (const line of wrapTextWithAnsi(optionHint, contentWidth)) {
				lines.push(padToWidth(boxLine(line)));
			}
			for (let i = 0; i < q.options.length; i++) {
				const option = q.options[i];
				const isSelected = selectedOptionIndexes.has(i);
				const prefix = isSelected ? this.green("☑") : this.dim("☐");
				const optionText = `${prefix} ${isSelected ? this.bold(this.formatOption(option)) : this.formatOption(option)}`;
				const wrappedOption = wrapTextWithAnsi(optionText, contentWidth);
				for (const line of wrappedOption) {
					lines.push(padToWidth(boxLine(line)));
				}
			}
		}

		lines.push(padToWidth(emptyBoxLine()));

		{
			// Render the editor component (multi-line input) with padding
			// Skip the first and last lines (editor's own border lines)
			const answerPrefix = this.bold(q.type === "freeform" ? "A: " : "Other: ");
			const editorWidth = contentWidth - 4 - 3; // Extra padding + space for "A: "
			const editorLines = this.editor.render(editorWidth);
			for (let i = 1; i < editorLines.length - 1; i++) {
				if (i === 1) {
					// First content line gets the "A: " prefix
					lines.push(padToWidth(boxLine(answerPrefix + editorLines[i])));
				} else {
					// Subsequent lines get padding to align with the first line
					lines.push(padToWidth(boxLine("   " + editorLines[i])));
				}
			}
		}

		lines.push(padToWidth(emptyBoxLine()));

		// Confirmation dialog or footer with controls
		if (this.showingConfirmation) {
			lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));
			const confirmMsg = `${this.yellow("Submit all answers?")} ${this.dim("(Enter/y to confirm, Esc/n to cancel)")}`;
			lines.push(padToWidth(boxLine(truncateToWidth(confirmMsg, contentWidth))));
		} else {
			lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));
			const optionControls = q.options?.length
				? ` · ${this.dim(this.optionShortcutHint(q))} toggle option(s)`
				: "";
			const newlineControl = ` · ${this.dim("Shift+Enter")} newline`;
			const controls = `${this.dim("Tab/Enter")} next · ${this.dim("Shift+Tab")} prev${newlineControl}${optionControls} · ${this.dim("Esc")} cancel`;
			lines.push(padToWidth(boxLine(truncateToWidth(controls, contentWidth))));
		}
		lines.push(padToWidth(this.dim("╰" + horizontalLine(boxWidth - 2) + "╯")));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

function messageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text: string } =>
			!!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}

function buildConversationContext(branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>, latestAssistantIndex: number): string {
	const contextEntries: string[] = [];
	const start = Math.max(0, latestAssistantIndex - 8);

	for (let i = start; i <= latestAssistantIndex; i++) {
		const entry = branch[i];
		if (entry?.type !== "message") continue;
		const msg = entry.message;
		if (!("role" in msg) || (msg.role !== "user" && msg.role !== "assistant")) continue;
		const text = messageText(msg).trim();
		if (!text) continue;
		const label = i === latestAssistantIndex ? "latest assistant" : msg.role;
		contextEntries.push(`${label}:\n${text}`);
	}

	return contextEntries.join("\n\n---\n\n");
}

function normalizeComparable(text: string | undefined): string {
	return (text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function questionsMatch(left: ExtractedQuestion[] | undefined, right: ExtractedQuestion[] | undefined): boolean {
	if (!left || !right || left.length !== right.length) return false;
	return left.every((question, index) => {
		const other = right[index];
		const sameId = question.id && other.id && normalizeComparable(question.id) === normalizeComparable(other.id);
		const sameQuestion = normalizeComparable(question.question) === normalizeComparable(other.question);
		if (!sameId && !sameQuestion) return false;
		if (question.type !== other.type) return false;
		const leftOptions = question.options ?? [];
		const rightOptions = other.options ?? [];
		if (leftOptions.length !== rightOptions.length) return false;
		return leftOptions.every((option, optionIndex) => normalizeComparable(option.text) === normalizeComparable(rightOptions[optionIndex]?.text));
	});
}

function findLatestDraft(branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>, sourceEntryId: string, questions: ExtractedQuestion[]): AnswerDraft | null {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as { type?: string; customType?: string; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== "answer:draft") continue;
		const draft = entry.data as AnswerDraft | undefined;
		if (!draft || draft.sourceEntryId !== sourceEntryId) continue;
		if (draft.state === "cleared") return null;
		return questionsMatch(draft.questions, questions) ? draft : null;
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	const answerHandler = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) {
			ctx.ui.notify("answer requires interactive mode", "error");
			return;
		}

		if (!ctx.model) {
			ctx.ui.notify("No model selected", "error");
			return;
		}

		// Find the last assistant message on the current branch
		const settings = await loadAnswerSettings(ctx.cwd);
		const branch = ctx.sessionManager.getBranch();
		let lastAssistantText: string | undefined;
		let lastAssistantIndex = -1;
		let lastAssistantEntryId = "";

		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message") {
				const msg = entry.message;
				if ("role" in msg && msg.role === "assistant") {
					if (msg.stopReason !== "stop") {
						ctx.ui.notify(`Last assistant message incomplete (${msg.stopReason})`, "error");
						return;
					}
					const text = messageText(msg);
					if (text.length > 0) {
						lastAssistantText = text;
						lastAssistantIndex = i;
						lastAssistantEntryId = String((entry as { id?: unknown }).id ?? i);
						break;
					}
				}
			}
		}

		if (!lastAssistantText) {
			ctx.ui.notify("No assistant messages found", "error");
			return;
		}

		const conversationContext = buildConversationContext(branch, lastAssistantIndex);
		const extractionModels = await selectConfiguredExtractionModels(ctx.model, ctx.modelRegistry, settings);

		// Run extraction with loader UI
		const extractionOutcome = await ctx.ui.custom<ExtractionOutcome>((tui, theme, _kb, done) => {
			const loader = new BorderedLoader(
				tui,
				theme,
				`Extracting questions using ${extractionModels.map((model) => model.id).join(", ")}...`,
			);
			loader.onAbort = () => done({ status: "cancelled" });

			const doExtract = async (): Promise<ExtractionResult | null> => {
				try {
					return await extractQuestionsWithModel(
						extractionModels,
						ctx.modelRegistry,
						lastAssistantText!,
						conversationContext,
						settings.systemPrompt ?? SYSTEM_PROMPT,
						loader.signal,
					);
				} catch (error) {
					if (error instanceof Error && error.message === "aborted") {
						return null;
					}
					throw error;
				}
			};

			doExtract()
				.then((result) => {
					if (result === null) {
						done({ status: "cancelled" });
						return;
					}
					done({ status: "ok", result });
				})
				.catch((error) =>
					done({
						status: "error",
						message: error instanceof Error ? error.message : String(error),
					}),
				);

			return loader;
		});

		if (extractionOutcome.status === "cancelled") {
			ctx.ui.notify("Cancelled", "info");
			return;
		}

		if (extractionOutcome.status === "error") {
			ctx.ui.notify(truncateToWidth(extractionOutcome.message, 120), "error");
			return;
		}

		const extractionResult = extractionOutcome.result;

		if (extractionResult.questions.length === 0) {
			ctx.ui.notify("No questions found in the last message", "info");
			return;
		}

		const draftSettings = { enabled: true, autosaveMs: 1000, promptOnRestore: true, ...settings.drafts };
		let initialDraft: Pick<AnswerDraft, "answers" | "selectedOptions"> | undefined;
		const foundDraft = draftSettings.enabled ? findLatestDraft(branch, lastAssistantEntryId, extractionResult.questions) : null;
		if (foundDraft) {
			const hasContent = foundDraft.answers.some((answer) => answer.trim()) || foundDraft.selectedOptions.some((indexes) => indexes.length > 0);
			if (hasContent && (!draftSettings.promptOnRestore || await ctx.ui.confirm("Resume draft answers?", "Saved answers were found for this assistant message. Restore them?"))) {
				initialDraft = foundDraft;
			}
		}

		let draftTimer: ReturnType<typeof setTimeout> | undefined;
		let pendingDraft: { answers: string[]; selectedOptions: Array<Set<number>> } | undefined;
		const appendDraft = (answers: string[], selectedOptions: Array<Set<number>>, state: AnswerDraft["state"]) => {
			(pi as unknown as { appendEntry?: (customType: string, data: unknown) => void }).appendEntry?.("answer:draft", {
				version: 1,
				sourceEntryId: lastAssistantEntryId,
				questions: extractionResult.questions,
				answers,
				selectedOptions: selectedOptions.map((set) => [...set]),
				state,
				updatedAt: Date.now(),
			} satisfies AnswerDraft);
		};
		const scheduleDraft = (answers: string[], selectedOptions: Array<Set<number>>) => {
			if (!draftSettings.enabled) return;
			pendingDraft = { answers, selectedOptions };
			if (draftTimer) clearTimeout(draftTimer);
			draftTimer = setTimeout(() => appendDraft(answers, selectedOptions, "draft"), draftSettings.autosaveMs);
		};

		// Show the Q&A component
		const answersResult = await ctx.ui.custom<string | null>((tui, _theme, _kb, done) => {
			return new QnAComponent(extractionResult.questions, tui, done, initialDraft, scheduleDraft);
		});
		if (draftTimer) clearTimeout(draftTimer);

		if (answersResult === null) {
			if (pendingDraft) appendDraft(pendingDraft.answers, pendingDraft.selectedOptions, "draft");
			ctx.ui.notify("Cancelled", "info");
			return;
		}

		appendDraft([], [], "cleared");
		if (answersResult.trim().length === 0) {
			ctx.ui.notify("No answers provided", "info");
			return;
		}

		// Send the answers directly as a message and trigger a turn
		pi.sendMessage(
			{
				customType: "answers",
				content: "I answered your questions in the following way:\n\n" + answersResult,
				display: true,
			},
			{ triggerTurn: true },
		);
	};

	pi.registerCommand("answer", {
		description: "Extract questions from last assistant message into interactive Q&A",
		handler: async (_args, ctx) => answerHandler(ctx),
	});

}
