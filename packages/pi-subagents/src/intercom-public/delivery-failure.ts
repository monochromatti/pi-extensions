import type { DeliveryFailure } from "./types.ts";

export function formatDeliveryFailure(failure: DeliveryFailure): string {
  switch (failure.code) {
    case "forged-sender":
      return "Sender identity was rejected by broker.";
    case "unregistered-sender":
      return "Sender is not registered with broker.";
    case "unsafe-machine-alias-target":
      return "Machine messages require exact target identity.";
    case "target-not-found":
      return "Target session not found. It may have ended; completed subagent results arrive through subagent(), not Intercom.";
    case "expired-target":
      return "Target session expired or disconnected. It may have ended; completed subagent results arrive through subagent(), not Intercom.";
	case "target-terminated":
		return `Subagent ${failure.agent} (run ${failure.runId}, child ${failure.index + 1}) has terminated. Use subagent status or its result artifact.`;
    case "ambiguous-alias": {
      const candidates = failure.candidates
        .map((candidate) => `${candidate.intercomSessionId}(pi=${candidate.piSessionId},alias=${candidate.alias},namespace=${candidate.namespace},cwd=${candidate.cwd})`)
        .join(", ");
      return `Alias target is ambiguous (${failure.label}). Candidates: ${candidates}`;
    }
    case "duplicate-pi-session": {
      const candidates = failure.candidates
        .map((candidate) => `${candidate.intercomSessionId}(pi=${candidate.piSessionId},alias=${candidate.alias},namespace=${candidate.namespace},cwd=${candidate.cwd})`)
        .join(", ");
      return `Multiple live sessions share piSessionId ${failure.piSessionId}. Candidates: ${candidates}`;
    }
  }
}

export function isRetryableDeliveryFailure(failure: DeliveryFailure | undefined): boolean {
  if (!failure) return false;
  return failure.code === "target-not-found" || failure.code === "expired-target";
}
