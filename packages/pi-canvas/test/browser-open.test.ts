import assert from "node:assert/strict";
import test from "node:test";
import { browserOpenCommand } from "../src/browser.ts";

test("9.1 browserOpenCommand picks the platform opener", () => {
	const url = "http://127.0.0.1:1234/?token=abc";

	assert.deepEqual(browserOpenCommand(url, "linux", {}), { command: "xdg-open", args: [url] });
	assert.deepEqual(browserOpenCommand(url, "darwin", {}), { command: "open", args: [url] });
	assert.deepEqual(browserOpenCommand(url, "win32", {}), {
		command: "cmd",
		args: ["/c", "start", "", url],
	});
});

test("9.2 browserOpenCommand honors $BROWSER override on any platform", () => {
	const url = "http://127.0.0.1:1234/?token=abc";

	assert.deepEqual(browserOpenCommand(url, "linux", { BROWSER: "firefox" }), {
		command: "firefox",
		args: [url],
	});
	assert.deepEqual(browserOpenCommand(url, "darwin", { BROWSER: " chromium " }), {
		command: "chromium",
		args: [url],
	});
	// Empty/blank override falls through to the platform default.
	assert.deepEqual(browserOpenCommand(url, "linux", { BROWSER: "  " }), {
		command: "xdg-open",
		args: [url],
	});
});
