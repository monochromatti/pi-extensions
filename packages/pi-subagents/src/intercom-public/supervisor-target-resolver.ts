import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SupervisorIntercomTarget } from "../shared/types.ts";

export interface IntercomSupervisorTargetResolver {
	getSupervisorTarget(piSessionId: string): Promise<SupervisorIntercomTarget>;
}

const RESOLVER_SYMBOL = Symbol.for("pi-subagents.intercom.supervisor-target-resolver");

type HostWithResolver = ExtensionAPI & {
	[RESOLVER_SYMBOL]?: IntercomSupervisorTargetResolver;
};

export function registerIntercomSupervisorTargetResolver(
	pi: ExtensionAPI,
	resolver: IntercomSupervisorTargetResolver,
): void {
	(pi as HostWithResolver)[RESOLVER_SYMBOL] = resolver;
}

export function getIntercomSupervisorTargetResolver(
	pi: ExtensionAPI,
): IntercomSupervisorTargetResolver | undefined {
	return (pi as HostWithResolver)[RESOLVER_SYMBOL];
}
