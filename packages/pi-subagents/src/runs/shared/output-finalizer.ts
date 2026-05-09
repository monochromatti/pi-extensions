import type { OutputMode, SavedOutputReference } from "../../shared/types.ts";
import {
	finalizeSingleOutput,
	formatSavedOutputReference,
	resolveSingleOutput,
	type SingleOutputSnapshot,
} from "./single-output.ts";

export interface FinalizeChildOutputInput {
	rawOutput: string;
	exitCode: number;
	outputPath?: string;
	outputMode?: OutputMode;
	outputSnapshot?: SingleOutputSnapshot;
	attemptNotes?: string[];
	truncatedOutput?: string;
}

export interface FinalizeChildOutputResult {
	fullOutput: string;
	displayOutput: string;
	savedPath?: string;
	outputReference?: SavedOutputReference;
	saveError?: string;
}

function prependAttemptNotes(output: string, attemptNotes: string[] | undefined): string {
	const notes = attemptNotes?.filter((note) => note.trim()).join("\n").trim();
	if (!notes) return output;
	return `${notes}\n\n${output}`.trim();
}

export function finalizeChildOutput(input: FinalizeChildOutputInput): FinalizeChildOutputResult {
	const resolvedOutput = input.outputPath && input.exitCode === 0
		? resolveSingleOutput(input.outputPath, input.rawOutput, input.outputSnapshot)
		: { fullOutput: input.rawOutput };
	const fullOutput = resolvedOutput.fullOutput;
	const outputReference = resolvedOutput.savedPath
		? formatSavedOutputReference(resolvedOutput.savedPath, fullOutput)
		: undefined;
	const outputForDisplay = prependAttemptNotes(fullOutput, input.attemptNotes);
	const finalized = finalizeSingleOutput({
		fullOutput: outputForDisplay,
		truncatedOutput: input.truncatedOutput,
		outputPath: input.outputPath,
		outputMode: input.outputMode,
		exitCode: input.exitCode,
		savedPath: resolvedOutput.savedPath,
		outputReference,
		saveError: resolvedOutput.saveError,
	});
	return {
		fullOutput,
		displayOutput: finalized.displayOutput,
		savedPath: finalized.savedPath,
		outputReference: finalized.outputReference,
		saveError: finalized.saveError,
	};
}
