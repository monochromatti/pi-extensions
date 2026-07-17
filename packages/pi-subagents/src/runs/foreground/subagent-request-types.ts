import type { ControlConfig, MaxOutputConfig } from "../../shared/types.ts";
import type { ChainStep } from "../../shared/settings.ts";

export interface TaskParam {
	agent: string;
	task: string;
	cwd?: string;
	count?: number;
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	reads?: string[] | boolean;
	progress?: boolean;
	model?: string;
	thinking?: string;
	requiredTools?: string[];
	skill?: string | string[] | boolean;
}

export interface SubagentParamsLike {
	action?: string;
	id?: string;
	runId?: string;
	dir?: string;
	index?: number;
	agent?: string;
	task?: string;
	message?: string;
	chain?: ChainStep[];
	tasks?: TaskParam[];
	concurrency?: number;
	context?: "fresh" | "fork";
	async?: boolean;
	share?: boolean;
	control?: ControlConfig;
	sessionDir?: string;
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	includeProgress?: boolean;
	model?: string;
	thinking?: string;
	requiredTools?: string[];
	skill?: string | string[] | boolean;
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
}
