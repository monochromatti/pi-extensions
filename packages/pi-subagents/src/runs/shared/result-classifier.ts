import type { Message } from "@earendil-works/pi-ai";
import type { ModelAttempt, Usage } from "../../shared/types.ts";
import { detectSubagentError } from "../../shared/error-detection.ts";
import { evaluateCompletionMutationGuard } from "./completion-guard.ts";

const COMPLETION_GUARD_ERROR = "Subagent completed without making edits for an implementation task.\nIt appears to have returned planning or scratchpad output instead of applying changes.";

interface ChildRunData {
	exitCode: number | null;
	messages: Message[];
	usage: Usage;
	model?: string;
	error?: string;
	stderr?: string;
	observedMutationAttempt?: boolean;
}

interface ClassifyChildRunResultInput {
	agent: string;
	task: string;
	run: ChildRunData;
	candidateModel?: string;
	defaultModel?: string;
}

interface ClassifyChildRunResultOutput {
	exitCode: number;
	error?: string;
	model?: string;
	usage: Usage;
	completionGuardTriggered: boolean;
	modelAttempt: ModelAttempt;
}

export function classifyChildRunResult(input: ClassifyChildRunResultInput): ClassifyChildRunResultOutput {
	const rawExitCode = input.run.exitCode ?? 1;
	const hiddenError = rawExitCode === 0 && !input.run.error ? detectSubagentError(input.run.messages) : null;
	const completionGuard = rawExitCode === 0 && !input.run.error && !hiddenError?.hasError
		? evaluateCompletionMutationGuard({
			agent: input.agent,
			task: input.task,
			messages: input.run.messages,
		})
		: undefined;
	const completionGuardTriggered = completionGuard?.triggered === true && !input.run.observedMutationAttempt;
	const effectiveExitCode = completionGuardTriggered
		? 1
		: hiddenError?.hasError
			? (hiddenError.exitCode ?? 1)
			: input.run.error && rawExitCode === 0
				? 1
				: rawExitCode;
	const error = completionGuardTriggered
		? COMPLETION_GUARD_ERROR
		: hiddenError?.hasError
			? hiddenError.details
				? `${hiddenError.errorType} failed (exit ${effectiveExitCode}): ${hiddenError.details}`
				: `${hiddenError.errorType} failed with exit code ${effectiveExitCode}`
			: input.run.error
				?? (effectiveExitCode !== 0 && input.run.stderr?.trim() ? input.run.stderr.trim() : undefined);

	const model = input.candidateModel ?? input.run.model;
	const modelAttempt: ModelAttempt = {
		model: model ?? input.defaultModel ?? "default",
		success: effectiveExitCode === 0 && !error,
		exitCode: effectiveExitCode,
		error,
		usage: input.run.usage,
	};

	return {
		exitCode: effectiveExitCode,
		error,
		model,
		usage: input.run.usage,
		completionGuardTriggered,
		modelAttempt,
	};
}
