import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { COMMAND_NAME } from "./src/constants.js";
import { openTreeMap } from "./src/command.js";

export default function (pi: ExtensionAPI) {
	pi.registerCommand(COMMAND_NAME, {
		description: "Open interactive session tree map",
		handler: async (_args, ctx) => {
			await openTreeMap(ctx);
		},
	});
}
