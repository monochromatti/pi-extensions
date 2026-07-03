import { spawn } from "node:child_process";

export type BrowserOpenCommand = { command: string; args: string[] };

/**
 * Pick the platform opener for a URL. `$BROWSER` wins when set, matching
 * common CLI convention.
 */
export function browserOpenCommand(
	url: string,
	platform: NodeJS.Platform = process.platform,
	env: Record<string, string | undefined> = process.env,
): BrowserOpenCommand {
	const override = env.BROWSER?.trim();
	if (override) return { command: override, args: [url] };
	if (platform === "darwin") return { command: "open", args: [url] };
	if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
	return { command: "xdg-open", args: [url] };
}

/**
 * Launch the default browser detached from the agent process. Resolves once
 * the opener process spawned; rejects when the opener binary is missing so
 * the caller can print the URL fallback.
 */
export function openInBrowser(url: string): Promise<void> {
	const { command, args } = browserOpenCommand(url);
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
	child.once("error", reject);
	child.once("spawn", () => {
		child.unref();
		resolve();
	});
	return promise;
}
