import type { Message } from "@earendil-works/pi-ai";
import type {
	ArtifactConfig,
	ControlEvent,
	ModelAttempt,
	OutputMode,
	SavedOutputReference,
	Usage,
} from "../../shared/types.ts";
import type { CompletionMutationGuardPolicy } from "../../shared/mutation-guard-policy.ts";
import {
	prepareChildRun,
	type ChildRunRequest,
	type PreparedChildRun,
} from "./child-run-preparation.ts";
import { classifyChildRunResult } from "./result-classifier.ts";
import { finalizeChildOutput } from "./output-finalizer.ts";
import { createRunArtifacts, type RunArtifacts } from "./run-artifacts.ts";
import { captureSingleOutputSnapshot, type SingleOutputSnapshot } from "./single-output.ts";
import {
	formatModelAttemptNote,
	isRetryableModelFailure,
} from "./model-fallback.ts";

export interface ChildAgentRunInput {
	agent: string;
	task: string;
	runId: string;
	baseArgs?: string[];
	index?: number;
	prepareRequest: Omit<ChildRunRequest, "task" | "identity" | "baseArgs" | "capabilities"> & {
		capabilities: Omit<ChildRunRequest["capabilities"], "model">;
	};
	modelCandidates?: string[];
	defaultModel?: string;
	mutationGuardPolicy?: CompletionMutationGuardPolicy;
	outputPath?: string;
	outputMode?: OutputMode;
	truncatedOutput?: string;
	artifactsDir?: string;
	artifactConfig?: Partial<ArtifactConfig>;
	onProgress?: (event: Record<string, unknown>) => void;
	onControlEvent?: (event: ControlEvent) => void;
}

export interface RunPreparedChildInput {
	prepared: PreparedChildRun;
	cwd?: string;
	attempt: number;
	onProgress?: (event: Record<string, unknown>) => void;
	onControlEvent?: (event: ControlEvent) => void;
}

export interface RunPreparedChildResult {
	exitCode: number | null;
	messages: Message[];
	usage: Usage;
	model?: string;
	error?: string;
	stderr?: string;
	rawOutput: string;
	observedMutationAttempt?: boolean;
}

export interface ChildAgentRunAdapters {
	runPreparedChild(input: RunPreparedChildInput): Promise<RunPreparedChildResult>;
	prepareChildRun?: typeof prepareChildRun;
	classifyChildRunResult?: typeof classifyChildRunResult;
	finalizeChildOutput?: typeof finalizeChildOutput;
	createRunArtifacts?: (input: {
		artifactsDir?: string;
		artifactConfig?: Partial<ArtifactConfig>;
		runId: string;
		agent: string;
		index?: number;
	}) => RunArtifacts;
	captureOutputSnapshot?: (outputPath: string | undefined) => SingleOutputSnapshot | undefined;
}

export interface ChildAgentRunResult {
	agent: string;
	task: string;
	exitCode: number;
	error?: string;
	model?: string;
	usage: Usage;
	messages: Message[];
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	attemptNotes: string[];
	completionGuardTriggered: boolean;
	fullOutput: string;
	finalOutput: string;
	savedOutputPath?: string;
	outputReference?: SavedOutputReference;
	outputSaveError?: string;
	artifactPaths?: RunArtifacts["paths"];
}

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function sumUsage(target: Usage, source: Usage): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.cost += source.cost;
	target.turns += source.turns;
}

function cloneForCallback<T>(value: T): T {
	try {
		return structuredClone(value);
	} catch {
		return JSON.parse(JSON.stringify(value)) as T;
	}
}

export async function runChildAgent(input: ChildAgentRunInput, adapters: ChildAgentRunAdapters): Promise<ChildAgentRunResult> {
	const prepare = adapters.prepareChildRun ?? prepareChildRun;
	const classify = adapters.classifyChildRunResult ?? classifyChildRunResult;
	const finalize = adapters.finalizeChildOutput ?? finalizeChildOutput;
	const artifactFactory = adapters.createRunArtifacts ?? createRunArtifacts;
	const snapshotter = adapters.captureOutputSnapshot ?? captureSingleOutputSnapshot;
	const candidates = input.modelCandidates && input.modelCandidates.length > 0
		? input.modelCandidates
		: [undefined];
	const attemptedModels: string[] = [];
	const modelAttempts: ModelAttempt[] = [];
	const attemptNotes: string[] = [];
	const aggregateUsage = emptyUsage();
	const artifacts = artifactFactory({
		artifactsDir: input.artifactsDir,
		artifactConfig: input.artifactConfig,
		runId: input.runId,
		agent: input.agent,
		index: input.index,
	});
	artifacts.recordInput(input.task);

	let finalRun: RunPreparedChildResult | undefined;
	let finalClassified: ReturnType<typeof classifyChildRunResult> | undefined;
	let finalSnapshot: SingleOutputSnapshot | undefined;

	for (let attemptIndex = 0; attemptIndex < candidates.length; attemptIndex++) {
		const candidate = candidates[attemptIndex];
		const prepared = prepare({
			baseArgs: input.baseArgs ?? ["--mode", "json", "-p"],
			task: input.task,
			identity: { runId: input.runId, agentName: input.agent, childIndex: input.index },
			context: input.prepareRequest.context,
			capabilities: {
				...input.prepareRequest.capabilities,
				model: candidate,
			},
			supervisor: input.prepareRequest.supervisor,
		});
		finalSnapshot = snapshotter(input.outputPath);
		let run: RunPreparedChildResult;
		try {
			run = await adapters.runPreparedChild({
				prepared,
				cwd: input.prepareRequest.context.cwd,
				attempt: attemptIndex,
				onProgress: input.onProgress
					? (event) => input.onProgress?.(cloneForCallback(event))
					: undefined,
				onControlEvent: input.onControlEvent
					? (event) => input.onControlEvent?.(cloneForCallback(event))
					: undefined,
			});
		} catch (error) {
			run = {
				exitCode: 1,
				messages: [],
				usage: emptyUsage(),
				error: error instanceof Error ? error.message : String(error),
				rawOutput: "",
			};
		} finally {
			prepared.cleanup();
		}

		const classified = classify({
			agent: input.agent,
			task: input.task,
			candidateModel: candidate,
			defaultModel: input.defaultModel,
			mutationGuardPolicy: input.mutationGuardPolicy,
			run: {
				exitCode: run.exitCode,
				messages: run.messages,
				usage: run.usage,
				model: run.model,
				error: run.error,
				stderr: run.stderr,
				observedMutationAttempt: run.observedMutationAttempt,
			},
		});
		if (candidate) attemptedModels.push(candidate);
		modelAttempts.push({ ...classified.modelAttempt, usage: run.usage });
		sumUsage(aggregateUsage, classified.usage);
		finalRun = run;
		finalClassified = classified;

		if (classified.modelAttempt.success || classified.completionGuardTriggered) break;
		if (!isRetryableModelFailure(classified.error) || attemptIndex === candidates.length - 1) break;
		attemptNotes.push(formatModelAttemptNote(classified.modelAttempt, candidates[attemptIndex + 1]));
	}

	const final = finalClassified ?? {
		exitCode: 1,
		error: "Subagent did not produce a result.",
		model: undefined,
		usage: emptyUsage(),
		completionGuardTriggered: false,
		modelAttempt: {
			model: input.defaultModel ?? "default",
			success: false,
			exitCode: 1,
			error: "Subagent did not produce a result.",
			usage: emptyUsage(),
		},
	};
	const finalizedOutput = finalize({
		rawOutput: finalRun?.rawOutput ?? "",
		exitCode: final.exitCode,
		outputPath: input.outputPath,
		outputMode: input.outputMode,
		outputSnapshot: finalSnapshot,
		attemptNotes,
		truncatedOutput: input.truncatedOutput,
	});

	artifacts.recordResult({
		task: input.task,
		output: finalizedOutput.fullOutput,
		exitCode: final.exitCode,
		usage: aggregateUsage,
		model: final.model,
		attemptedModels: attemptedModels.length > 0 ? attemptedModels : undefined,
		modelAttempts,
		error: final.error,
	});

	return {
		agent: input.agent,
		task: input.task,
		exitCode: final.exitCode,
		error: final.error,
		model: final.model,
		usage: aggregateUsage,
		messages: finalRun?.messages ?? [],
		attemptedModels: attemptedModels.length > 0 ? attemptedModels : undefined,
		modelAttempts: modelAttempts.length > 0 ? modelAttempts : undefined,
		attemptNotes,
		completionGuardTriggered: final.completionGuardTriggered,
		fullOutput: finalizedOutput.fullOutput,
		finalOutput: finalizedOutput.displayOutput,
		savedOutputPath: finalizedOutput.savedPath,
		outputReference: finalizedOutput.outputReference,
		outputSaveError: finalizedOutput.saveError,
		artifactPaths: artifacts.paths,
	};
}
