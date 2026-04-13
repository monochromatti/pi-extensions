import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { autoLabelLatestMapNode, backfillMapNodeLabels } from "./src/auto-label.js";

const BACKFILL_COMMAND = "autolabel-backfill";

export default function (pi: ExtensionAPI) {
	pi.on("turn_end", async (_event, ctx) => {
		try {
			await autoLabelLatestMapNode(pi, ctx);
		} catch {
			// Best-effort background labeling; stay silent on failure.
		}
	});

	pi.registerCommand(BACKFILL_COMMAND, {
		description: "Backfill persisted AI labels for unlabeled map nodes",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Starting auto-label backfill...", "info");
			const result = await backfillMapNodeLabels(pi, ctx);
			if (result.candidates === 0) {
				ctx.ui.notify("No unlabeled map nodes found to backfill", "info");
				return;
			}

			if (result.failed === result.candidates && result.labeled === 0 && result.failureReasons.length > 0) {
				ctx.ui.notify(`Auto-label backfill unavailable: ${result.failureReasons[0]}`, "warning");
				return;
			}

			const summary = [
				`Backfill complete: labeled ${result.labeled}`,
				result.skippedExisting > 0 ? `skipped existing ${result.skippedExisting}` : undefined,
				result.skippedInFlight > 0 ? `skipped busy ${result.skippedInFlight}` : undefined,
				result.failed > 0 ? `failed ${result.failed}` : undefined,
			]
				.filter(Boolean)
				.join(", ");

			ctx.ui.notify(summary, result.failed > 0 ? "warning" : "success");
		},
	});
}
