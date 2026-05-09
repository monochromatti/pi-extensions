import {
	type ArtifactConfig,
	type ArtifactPaths,
	type ModelAttempt,
	type Usage,
} from "../../shared/types.ts";
import {
	ensureArtifactsDir,
	getArtifactPaths,
	writeArtifact,
	writeMetadata,
} from "../../shared/artifacts.ts";

export interface CreateRunArtifactsInput {
	artifactsDir?: string;
	artifactConfig?: Partial<ArtifactConfig>;
	runId: string;
	agent: string;
	index?: number;
}

export interface RecordRunArtifactResultInput {
	task: string;
	output: string;
	exitCode: number | null;
	usage?: Usage;
	model?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	durationMs?: number;
	toolCount?: number;
	error?: string;
	skills?: string[];
	skillsWarning?: string;
}

export interface RunArtifacts {
	paths?: ArtifactPaths;
	jsonlPath?: string;
	recordInput(task: string): void;
	recordResult(input: RecordRunArtifactResultInput): void;
}

function noOpArtifacts(): RunArtifacts {
	return {
		recordInput: () => {},
		recordResult: () => {},
	};
}

export function createRunArtifacts(config: CreateRunArtifactsInput): RunArtifacts {
	if (!config.artifactsDir || config.artifactConfig?.enabled === false) {
		return noOpArtifacts();
	}
	const paths = getArtifactPaths(config.artifactsDir, config.runId, config.agent, config.index);
	ensureArtifactsDir(config.artifactsDir);
	const includeInput = config.artifactConfig?.includeInput !== false;
	const includeOutput = config.artifactConfig?.includeOutput !== false;
	const includeMetadata = config.artifactConfig?.includeMetadata !== false;
	const includeJsonl = config.artifactConfig?.includeJsonl !== false;

	return {
		paths,
		jsonlPath: includeJsonl ? paths.jsonlPath : undefined,
		recordInput: (task: string) => {
			if (!includeInput) return;
			writeArtifact(paths.inputPath, `# Task for ${config.agent}\n\n${task}`);
		},
		recordResult: (input: RecordRunArtifactResultInput) => {
			if (includeOutput) {
				writeArtifact(paths.outputPath, input.output);
			}
			if (includeMetadata) {
				writeMetadata(paths.metadataPath, {
					runId: config.runId,
					agent: config.agent,
					task: input.task,
					exitCode: input.exitCode,
					usage: input.usage,
					model: input.model,
					attemptedModels: input.attemptedModels,
					modelAttempts: input.modelAttempts,
					durationMs: input.durationMs,
					toolCount: input.toolCount,
					error: input.error,
					skills: input.skills,
					skillsWarning: input.skillsWarning,
					timestamp: Date.now(),
				});
			}
		},
	};
}
