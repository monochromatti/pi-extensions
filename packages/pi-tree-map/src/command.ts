import { BorderedLoader, type ExtensionCommandContext, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { startPersistentLabelsForEntryIds, type PersistedLabelController } from "../../pi-auto-label/src/auto-label.js";
import { buildTreeMapModel } from "./build-graph.js";
import { FILTER_MODES, LABEL_MODES } from "./constants.js";
import { layoutTree } from "./layout.js";
import type { FilterMode, LabelMode, Snapshot } from "./model.js";
import { TreeMapComponent } from "./tree-map-component.js";

interface TreeMapExit {
	action: "close" | "jump";
	targetId?: string;
}

interface NavigateTreeResult {
	cancelled: boolean;
	aborted?: boolean;
	editorText?: string;
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
	while (true) {
		const choice = await ctx.ui.select(
			`Jump to:\n${target.title}\n(${target.anchorEntryId.slice(0, 8)})\n\nSummarize branch?`,
			["No summary", "Summarize", "Summarize with custom prompt"],
		);
		if (!choice) return undefined;
		if (choice === "No summary") return { summarize: false };
		if (choice === "Summarize") return { summarize: true };
		const custom = await ctx.ui.editor("Custom summarization instructions", "");
		if (custom === undefined) continue;
		return { summarize: true, customInstructions: custom };
	}
}

async function navigateTreeWithProgress(
	ctx: ExtensionCommandContext,
	targetId: string,
	options: { summarize: boolean; customInstructions?: string },
): Promise<NavigateTreeResult> {
	if (!options.summarize) {
		return (await ctx.navigateTree(targetId, options)) as NavigateTreeResult;
	}

	let error: unknown;
	const result = await ctx.ui.custom<NavigateTreeResult | undefined>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, "Summarizing branch...", { cancellable: false });

		void ctx
			.navigateTree(targetId, options)
			.then((value) => done(value as NavigateTreeResult))
			.catch((err) => {
				error = err;
				done(undefined);
			});

		return loader;
	});

	if (error) throw error;
	return result || { cancelled: true };
}

export async function openTreeMap(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/map requires interactive mode", "warning");
		return;
	}

	await ctx.waitForIdle();
	const snapshot = snapshotFromContext(ctx);

	let labelMode: LabelMode = "smart";
	let filterMode: FilterMode = "all";
	let autoLabelEnabled = true;
	let labelStatus = "Labels: loading";
	let labelController: PersistedLabelController | undefined;
	let labelGeneration = 0;
	let selectedNodeId = "";
	let model = layoutTree(buildTreeMapModel(snapshot, { labelMode, filterMode }), process.stdout.columns || 120);
	let component: TreeMapComponent | undefined;
	let requestRender: (() => void) | undefined;
	selectedNodeId = model.currentNodeId || model.rootNodeId;

	const rebuildBase = (): void => {
		model = layoutTree(buildTreeMapModel(snapshot, { labelMode, filterMode }), process.stdout.columns || 120);
		if (!model.nodes.some((node) => node.nodeId === selectedNodeId)) {
			selectedNodeId = model.currentNodeId || model.rootNodeId;
		}
	};

	const stopLabeling = (): void => {
		labelGeneration += 1;
		labelController?.cancel();
		labelController = undefined;
	};

	const startLabeling = async (): Promise<void> => {
		stopLabeling();
		if (!autoLabelEnabled) {
			labelStatus = "Labels: off";
			requestRender?.();
			return;
		}
		const unlabeledIds = model.nodes.filter((node) => !node.isRoot && !node.isLabeled).map((node) => node.anchorEntryId);
		if (unlabeledIds.length === 0) {
			labelStatus = "Labels: ready";
			requestRender?.();
			return;
		}

		labelStatus = "Labels: loading";
		requestRender?.();
		const generation = labelGeneration;
		labelController = await startPersistentLabelsForEntryIds(pi, ctx, unlabeledIds, {
			onLabel: (entryId, label) => {
				if (generation !== labelGeneration) return;
				snapshot.labelById[entryId] = label;
				rebuildBase();
				component?.invalidate();
				requestRender?.();
			},
			onStatus: (status) => {
				if (generation !== labelGeneration) return;
				labelStatus = status;
				requestRender?.();
			},
		});
	};

	const rebuild = async (): Promise<void> => {
		rebuildBase();
		await startLabeling();
		component?.invalidate();
		requestRender?.();
	};

	while (true) {
		component = undefined;
		requestRender = undefined;

		const result = await ctx.ui.custom<TreeMapExit>((tui, _theme, _kb, done) => {
			requestRender = () => tui.requestRender();
			component = new TreeMapComponent({
				tui,
				getModel: () => model,
				getTheme: () => ctx.ui.theme,
				getSelectedNodeId: () => selectedNodeId,
				setSelectedNodeId: (id) => {
					selectedNodeId = id;
				},
				getLabelMode: () => labelMode,
				getFilterMode: () => filterMode,
				getLabelStatus: () => labelStatus,
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
				onToggleAutoLabel: async () => {
					autoLabelEnabled = !autoLabelEnabled;
					await rebuild();
				},
			});
			void startLabeling();
			return component;
		});

		stopLabeling();

		if (!result || result.action !== "jump" || !result.targetId) return;
		const targetNode = model.nodes.find((node) => node.nodeId === result.targetId);
		if (!targetNode || targetNode.isRoot) continue;

		const options = await promptSummarizeOptions(ctx, {
			title: targetNode.title,
			anchorEntryId: targetNode.anchorEntryId,
		});
		if (!options) continue;

		try {
			const navigateResult = await navigateTreeWithProgress(ctx, targetNode.anchorEntryId, {
				summarize: options.summarize,
				customInstructions: options.customInstructions,
			});
			if (navigateResult.aborted) {
				ctx.ui.notify("Branch summarization cancelled", "info");
				continue;
			}
			if (navigateResult.cancelled) {
				ctx.ui.notify("Navigation cancelled", "info");
				continue;
			}
			return;
		} catch (error) {
			ctx.ui.notify(`Failed to navigate: ${error}`, "error");
		}
	}
}
