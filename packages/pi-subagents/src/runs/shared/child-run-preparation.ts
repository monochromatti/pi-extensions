import { getSubagentDepthEnv } from "../../shared/types.ts";
import {
	applyThinkingSuffix,
	buildPiArgs,
	cleanupTempDir,
	SUBAGENT_CHILD_AGENT_ENV,
	SUBAGENT_CHILD_INDEX_ENV,
	SUBAGENT_INTERCOM_SESSION_NAME_ENV,
	SUBAGENT_ORCHESTRATOR_CWD_ENV,
	SUBAGENT_ORCHESTRATOR_TARGET_ENV,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_SUPERVISOR_ALIAS_ENV,
	SUBAGENT_SUPERVISOR_CWD_ENV,
	SUBAGENT_SUPERVISOR_INTERCOM_SESSION_ID_ENV,
	SUBAGENT_SUPERVISOR_PI_SESSION_ID_ENV,
	SUBAGENT_SUPERVISOR_WAIT_MODE_ENV,
	type BuildPiArgsInput,
	type BuildPiArgsResult,
} from "./pi-args.ts";
import type { SupervisorIntercomTarget } from "../../shared/types.ts";

/**
 * Module: child-run preparation.
 * Interface: ChildRunRequest -> PreparedChildRun.
 * Seam: callers own spawn/lifecycle; this Module owns Pi args, child env,
 * depth env, and temp prompt/task file cleanup through the pi-args Adapter.
 */
export interface ChildRunIdentity {
	runId?: string;
	agentName: string;
	childIndex?: number;
}

export interface ChildRunContext {
	cwd?: string;
	sessionEnabled: boolean;
	sessionDir?: string;
	sessionFile?: string;
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	maxSubagentDepth?: number;
}

export interface ChildRunCapabilities {
	model?: string;
	thinking?: string;
	tools?: string[];
	extensions?: string[];
	mcpDirectTools?: string[];
	systemPrompt?: string | null;
	systemPromptMode?: "append" | "replace";
	promptFileStem?: string;
}

export interface ChildRunSupervisor {
	childIntercomTarget?: string;
	orchestratorIntercomTarget?: string;
	orchestratorIntercomCwd?: string;
	supervisorIntercomTarget?: SupervisorIntercomTarget;
	supervisorWaitMode?: "foreground" | "async";
}

export interface ChildRunRequest {
	baseArgs: string[];
	task: string;
	identity: ChildRunIdentity;
	context: ChildRunContext;
	capabilities: ChildRunCapabilities;
	supervisor?: ChildRunSupervisor;
}

export interface PreparedChildRun {
	args: string[];
	env: Record<string, string | undefined>;
	spawnEnv: NodeJS.ProcessEnv;
	tempDir?: string;
	model?: string;
	identity: ChildRunIdentity;
	supervisor?: ChildRunSupervisor;
	cleanup(): void;
}

export interface ChildRunPreparationAdapter {
	buildPiArgs(input: BuildPiArgsInput): BuildPiArgsResult;
	getDepthEnv(maxDepth?: number): Record<string, string>;
	cleanupTempDir(tempDir: string | null | undefined): void;
}

export const defaultChildRunPreparationAdapter: ChildRunPreparationAdapter = {
	buildPiArgs,
	getDepthEnv: getSubagentDepthEnv,
	cleanupTempDir,
};

const CHILD_ROUTING_ENV_KEYS = [
	SUBAGENT_INTERCOM_SESSION_NAME_ENV,
	SUBAGENT_ORCHESTRATOR_TARGET_ENV,
	SUBAGENT_ORCHESTRATOR_CWD_ENV,
	SUBAGENT_SUPERVISOR_INTERCOM_SESSION_ID_ENV,
	SUBAGENT_SUPERVISOR_PI_SESSION_ID_ENV,
	SUBAGENT_SUPERVISOR_ALIAS_ENV,
	SUBAGENT_SUPERVISOR_CWD_ENV,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_CHILD_AGENT_ENV,
	SUBAGENT_CHILD_INDEX_ENV,
	SUBAGENT_SUPERVISOR_WAIT_MODE_ENV,
] as const;

export function prepareChildRun(
	request: ChildRunRequest,
	adapter: ChildRunPreparationAdapter = defaultChildRunPreparationAdapter,
): PreparedChildRun {
	const built = adapter.buildPiArgs({
		baseArgs: request.baseArgs,
		task: request.task,
		sessionEnabled: request.context.sessionEnabled,
		sessionDir: request.context.sessionDir,
		sessionFile: request.context.sessionFile,
		model: request.capabilities.model,
		thinking: request.capabilities.thinking,
		systemPromptMode: request.capabilities.systemPromptMode,
		inheritProjectContext: request.context.inheritProjectContext,
		inheritSkills: request.context.inheritSkills,
		tools: request.capabilities.tools,
		extensions: request.capabilities.extensions,
		systemPrompt: request.capabilities.systemPrompt,
		mcpDirectTools: request.capabilities.mcpDirectTools,
		promptFileStem: request.capabilities.promptFileStem,
		intercomSessionName: request.supervisor?.childIntercomTarget,
		orchestratorIntercomTarget: request.supervisor?.orchestratorIntercomTarget,
		orchestratorIntercomCwd: request.supervisor?.orchestratorIntercomCwd,
		supervisorIntercomTarget: request.supervisor?.supervisorIntercomTarget,
		supervisorWaitMode: request.supervisor?.supervisorWaitMode,
		runId: request.identity.runId,
		childAgentName: request.identity.agentName,
		childIndex: request.identity.childIndex,
	});
	const spawnEnv = { ...process.env };
	for (const key of CHILD_ROUTING_ENV_KEYS) {
		delete spawnEnv[key];
	}
	Object.assign(spawnEnv, built.env, adapter.getDepthEnv(request.context.maxSubagentDepth));
	let cleaned = false;
	return {
		args: built.args,
		env: built.env,
		spawnEnv,
		tempDir: built.tempDir,
		model: applyThinkingSuffix(request.capabilities.model, request.capabilities.thinking),
		identity: request.identity,
		supervisor: request.supervisor,
		cleanup() {
			if (cleaned) return;
			cleaned = true;
			adapter.cleanupTempDir(built.tempDir);
		},
	};
}
