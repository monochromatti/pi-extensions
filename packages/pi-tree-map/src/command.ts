import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { startAiSummaries, type AiSummaryController } from "./ai-summaries.js";
import { buildTreeMapModel } from "./build-graph.js";
import { FILTER_MODES, LABEL_MODES } from "./constants.js";
import { layoutTree } from "./layout.js";
import type { FilterMode, LabelMode, Snapshot } from "./model.js";
import { TreeMapComponent } from "./tree-map-component.js";

interface TreeMapExit {
	action: "close" | "jump";
	targetId?: string;
}

function nextMode<T extends string>(arr: T[], current: T): T {
	const idx = arr.indexOf(current);
	return arr[(idx + 1) % arr.length] || arr[0]!;
}

function snapshotFromContext(ctx: ExtensionCommandContext): Snapshot {
	const entries = ctx.sessionManager.getEntries() as Snapshot["entries"];
	const labelById: Record<string, string | undefined> = {};
	for (const e of entries) {
		labelById[e.id] = ctx.sessionManager.getLabel(e.id);
	}
	const sm = ctx.sessionManager as unknown as { getLeafEntry?: () => { id: string } | undefined; getLeafId?: () => string | null };
	const currentLeafId = sm.getLeafEntry?.()?.id ?? sm.getLeafId?.() ?? entries.at(-1)?.id;
	return { entries, currentLeafId: currentLeafId || undefined, labelById };
}

async function promptSummarizeOptions(
	ctx: ExtensionCommandContext,
	target: { title: string; anchorEntryId: string },
): Promise<{ summarize: boolean; customInstructions?: string } | undefined> {
	const choice = await ctx.ui.select(
		`Jump to:\n${target.title}\n(${target.anchorEntryId.slice(0, 8)})\n\nJump options`,
		["No summary", "Summarize", "Summarize with custom prompt"],
	);
	if (!choice) return undefined;
	if (choice === "No summary") return { summarize: false };
	if (choice === "Summarize") return { summarize: true };
	const custom = await ctx.ui.editor("Summarization prompt", "");
	if (custom === undefined) return undefined;
	return { summarize: true, customInstructions: custom };
}

export async function openTreeMap(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/map requires interactive mode", "warning");
		return;
	}

	await ctx.waitForIdle();
	const snapshot = snapshotFromContext(ctx);

	let labelMode: LabelMode = "smart";
	let filterMode: FilterMode = "all";
	let aiEnabled = true;
	let aiStatus = "AI: loading";
	let aiController: AiSummaryController | undefined;
	let aiGeneration = 0;
	let selectedNodeId = "";
	let model = layoutTree(buildTreeMapModel(snapshot, { labelMode, filterMode }), process.stdout.columns || 120);
	selectedNodeId = model.currentNodeId || model.rootNodeId;

	let component: TreeMapComponent | undefined;
	let requestRender: (() => void) | undefined;

	const rebuildBase = (): void => {
		model = layoutTree(buildTreeMapModel(snapshot, { labelMode, filterMode }), process.stdout.columns || 120);
		if (!model.nodes.some((n) => n.nodeId === selectedNodeId)) {
			selectedNodeId = model.currentNodeId || model.rootNodeId;
		}
	};

	const stopAi = (): void => {
		aiGeneration += 1;
		aiController?.cancel();
		aiController = undefined;
	};

	const startAi = async (): Promise<void> => {
		stopAi();
		if (!aiEnabled) {
			aiStatus = "AI: off";
			requestRender?.();
			return;
		}
		if (labelMode !== "smart") {
			aiStatus = "AI: smart mode only";
			requestRender?.();
			return;
		}

		aiStatus = "AI: loading";
		requestRender?.();
		const generation = aiGeneration;
		aiController = await startAiSummaries(ctx, model, snapshot, {
			onTitle: (nodeId, title) => {
				if (generation !== aiGeneration) return;
				const node = model.nodes.find((n) => n.nodeId === nodeId);
				if (!node || node.isLabeled) return;
				node.title = title;
				component?.invalidate();
				requestRender?.();
			},
			onStatus: (status) => {
				if (generation !== aiGeneration) return;
				aiStatus = status;
				requestRender?.();
			},
		});
	};

	const rebuild = async (): Promise<void> => {
		rebuildBase();
		await startAi();
		component?.invalidate();
		requestRender?.();
	};

	const result = await ctx.ui.custom<TreeMapExit>((tui, _theme, _kb, done) => {
		requestRender = () => tui.requestRender();
		component = new TreeMapComponent({
			tui,
			getModel: () => model,
			getSelectedNodeId: () => selectedNodeId,
			setSelectedNodeId: (id) => {
				selectedNodeId = id;
			},
			getLabelMode: () => labelMode,
			getFilterMode: () => filterMode,
			getAiSummaryStatus: () => aiStatus,
			onEnter: async (nodeId) => {
				done({ action: "jump", targetId: nodeId });
			},
			onClose: () => done({ action: "close" }),
			onCycleLabel: async () => {
				labelMode = nextMode(LABEL_MODES, labelMode);
				await rebuild();
			},
			onCycleFilter: async () => {
				filterMode = nextMode(FILTER_MODES, filterMode);
				await rebuild();
			},
			onToggleAiSummary: async () => {
				aiEnabled = !aiEnabled;
				await rebuild();
			},
		});
		void startAi();
		return component;
	});

	stopAi();

	if (!result || result.action !== "jump" || !result.targetId) return;
	const targetNode = model.nodes.find((n) => n.nodeId === result.targetId);
	if (!targetNode || targetNode.isRoot) return;

	const options = await promptSummarizeOptions(ctx, {
		title: targetNode.title,
		anchorEntryId: targetNode.anchorEntryId,
	});
	if (!options) return;

	try {
		await ctx.navigateTree(targetNode.anchorEntryId, {
			summarize: options.summarize,
			customInstructions: options.customInstructions,
		});
	} catch (error) {
		ctx.ui.notify(`Failed to navigate: ${error}`, "error");
	}
}
