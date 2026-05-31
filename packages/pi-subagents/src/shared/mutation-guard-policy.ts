export type CompletionMutationGuardPolicy = "auto" | "never" | "explicit" | "always";

export function defaultCompletionMutationGuardPolicy(agent: string): CompletionMutationGuardPolicy {
	if (/\b(?:oracle|planner|researcher|scout|investigate)\b/i.test(agent)) return "never";
	if (/\breviewer\b/i.test(agent)) return "explicit";
	return "auto";
}
