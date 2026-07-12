import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";
import { buildCanvasExportHtml, exportCanvas } from "../src/export.ts";
import { renderToCanvas } from "../src/render.ts";
import { createCanvasSession } from "../src/session.ts";

const minimalAssets = {
	shell: `<!doctype html>
<html lang="en">
<head><link rel="stylesheet" href="/styles.css" /><title>Pi Canvas</title></head>
<body>
<header id="status" data-canvas-slot="status"></header>
<main id="root" data-canvas-slot="root"><section id="canvas-empty-state">empty</section></main>
<aside id="sidebar" data-canvas-slot="sidebar"></aside>
<script src="/components.js" defer></script>
<script src="/client.js" defer></script>
</body></html>`,
	styles: "body { color: black; }",
	components: "globalThis.componentsLoaded = true;",
	marked: "globalThis.markedBundled = true;",
	mermaid: "globalThis.mermaidBundled = true;",
};

test("export builds standalone canvas and replays all patch modes", () => {
	const session = createCanvasSession({ token: "secret-token" });
	renderToCanvas(session, {
		selector: "#root",
		html: `<section id="canvas-content" data-canvas-slot="content"><span>A</span></section>`,
	});
	renderToCanvas(session, { selector: "#canvas-content", html: "<b>B</b>", mode: "prepend" });
	renderToCanvas(session, { selector: "#canvas-content", html: "<i>C</i>", mode: "append" });
	renderToCanvas(session, { selector: "#status", html: "Ready", mode: "inner" });
	renderToCanvas(session, { selector: "#canvas-content", html: "<article>Final</article>", mode: "outer" });

	const html = buildCanvasExportHtml(session, minimalAssets);
	const dom = new JSDOM(html, { runScripts: "dangerously" });

	assert.equal(dom.window.document.querySelector("#canvas-empty-state"), null);
	assert.equal(dom.window.document.querySelector("#root")?.innerHTML, "<article>Final</article>");
	assert.equal(dom.window.document.querySelector("#status")?.textContent, "Ready");
	assert.equal((dom.window as any).componentsLoaded, true);
	assert.equal((dom.window as any).markedBundled, true);
	assert.equal((dom.window as any).mermaidBundled, true);
	assert.equal(html.includes("secret-token"), false);
	assert.match(html, /default-src 'self' data:;/);
	assert.equal(html.includes('src="/client.js"'), false);
	assert.equal(html.includes('src="/components.js"'), false);
	assert.equal(html.includes('href="/styles.css"'), false);
	assert.match(html, /data-canvas-export/);
	assert.match(html, /form-action 'none'/);
});

test("export restores signals, keeps local reactivity, and disables backend events", () => {
	const session = createCanvasSession();
	session.signals = { note: "saved", reveal: "yes" };
	renderToCanvas(session, {
		selector: "#root",
		html: `<section>
			<textarea data-signal="note"></textarea>
			<p id="revealed" data-show="reveal">Visible</p>
			<button id="send" data-event="checkpoint:send" data-enable-when="note">Send</button>
		</section>`,
	});

	const dom = new JSDOM(buildCanvasExportHtml(session, minimalAssets), { runScripts: "dangerously" });
	const document = dom.window.document;
	const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
	const revealed = document.querySelector("#revealed") as HTMLElement;
	const send = document.querySelector("#send") as HTMLButtonElement;

	assert.equal(textarea.value, "saved");
	assert.equal(revealed.hidden, false);
	assert.equal(send.disabled, true);
	assert.equal(send.title, "Unavailable in static export");

	textarea.value = "changed";
	textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	assert.equal(textarea.value, "changed");
	assert.equal(send.disabled, true);
});

test("export escapes snapshot data that could close its script element", () => {
	const session = createCanvasSession();
	session.signals = { unsafe: "</script><script>globalThis.injected = true</script>" };
	const html = buildCanvasExportHtml(session, minimalAssets);
	const dom = new JSDOM(html, { runScripts: "dangerously" });

	assert.equal((dom.window as any).injected, undefined);
	assert.equal(html.includes("</script><script>globalThis.injected"), false);
});

test("exportCanvas writes a complete file and creates parent directories", async () => {
	const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-canvas-export-"));
	try {
		const session = createCanvasSession();
		renderToCanvas(session, { selector: "#root", html: "<h1>Exported</h1>" });
		const outputPath = path.join(temporary, "Nested", "Canvas.HTML");
		const result = await exportCanvas(session, { outputPath });
		const html = await readFile(outputPath, "utf8");

		assert.equal(result.path, outputPath);
		assert.equal(result.patchCount, 2);
		assert.match(html, /Exported/);
		const document = new JSDOM(html).window.document;
		assert.equal(document.querySelector('script[src="/client.js"]'), null);
		assert.match(document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "", /connect-src 'none'/);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});
