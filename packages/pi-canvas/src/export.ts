import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { CanvasSessionState } from "./session.ts";

const extensionDir = path.dirname(fileURLToPath(new URL("../index.ts", import.meta.url)));
const staticDir = path.join(extensionDir, "static");
const require = createRequire(import.meta.url);
const markedBundlePath = require.resolve("marked/marked.min.js");
const mermaidBundlePath = require.resolve("mermaid/dist/mermaid.min.js");

export type CanvasExportOptions = {
	outputPath: string;
};

export type CanvasExportResult = {
	path: string;
	patchCount: number;
};

export async function exportCanvas(
	session: CanvasSessionState,
	options: CanvasExportOptions,
): Promise<CanvasExportResult> {
	const [shell, styles, components, marked, mermaid] = await Promise.all([
		readFile(path.join(staticDir, "index.html"), "utf8"),
		readFile(path.join(staticDir, "styles.css"), "utf8"),
		readFile(path.join(staticDir, "components.js"), "utf8"),
		readFile(markedBundlePath, "utf8"),
		readFile(mermaidBundlePath, "utf8"),
	]);

	const outputPath = path.resolve(options.outputPath);
	const html = buildCanvasExportHtml(session, { shell, styles, components, marked, mermaid });
	await mkdir(path.dirname(outputPath), { recursive: true });
	await writeFile(outputPath, html, "utf8");

	return { path: outputPath, patchCount: session.render.patches.length };
}

type CanvasExportAssets = {
	shell: string;
	styles: string;
	components: string;
	marked: string;
	mermaid: string;
};

export function buildCanvasExportHtml(session: CanvasSessionState, assets: CanvasExportAssets): string {
	const scriptMarkers = /\s*<script src="\/components\.js" defer><\/script>\s*<script src="\/client\.js" defer><\/script>/;
	if (!assets.shell.includes('<link rel="stylesheet" href="/styles.css" />') || !scriptMarkers.test(assets.shell)) {
		throw new Error("Canvas export shell markers not found");
	}

	const snapshot = escapeScriptData(JSON.stringify({
		patches: session.render.patches,
		signals: session.signals,
	}));
	const componentScript = escapeScriptClosingTags(assets.components);
	const markedScript = escapeScriptClosingTags(assets.marked);
	const mermaidScript = escapeScriptClosingTags(assets.mermaid);

	let html = assets.shell
		.replace("<html lang=\"en\">", "<html lang=\"en\" data-canvas-export>")
		.replace("<title>Pi Canvas</title>", "<title>Pi Canvas export</title>")
		.replace(
			"<link rel=\"stylesheet\" href=\"/styles.css\" />",
			() => `<meta http-equiv="Content-Security-Policy" content="default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; form-action 'none'; object-src 'none'; base-uri 'none'" />\n\t\t<style>\n${assets.styles}\n\t\t</style>`,
		)
		.replace(
			scriptMarkers,
			() => `\n\t\t<script id="pi-canvas-export-data" type="application/json">${snapshot}</script>\n\t\t<script>${EXPORT_BOOTSTRAP}</script>\n\t\t<script>${markedScript}</script>\n\t\t<script>${mermaidScript}</script>\n\t\t<script>${componentScript}</script>`,
		);

	if (!html.endsWith("\n")) html += "\n";
	return html;
}

function escapeScriptData(value: string): string {
	return value
		.replace(/</g, "\\u003c")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}

function escapeScriptClosingTags(value: string): string {
	return value.replace(/<\/script/gi, "<\\/script");
}

const EXPORT_BOOTSTRAP = `(() => {
	const dataElement = document.getElementById("pi-canvas-export-data");
	if (!dataElement) return;

	let snapshot;
	try {
		snapshot = JSON.parse(dataElement.textContent || "{}");
	} catch {
		snapshot = {};
	}
	dataElement.remove();

	const signals = snapshot && typeof snapshot.signals === "object" && snapshot.signals
		? { ...snapshot.signals }
		: {};
	const patches = Array.isArray(snapshot?.patches) ? snapshot.patches : [];

	for (const patch of patches) {
		if (!patch || typeof patch.selector !== "string") continue;
		const target = document.querySelector(patch.selector);
		if (!target) continue;
		const html = typeof patch.html === "string" ? patch.html : "";
		switch (patch.mode) {
			case "outer":
				target.outerHTML = html;
				break;
			case "append":
				target.insertAdjacentHTML("beforeend", html);
				break;
			case "prepend":
				target.insertAdjacentHTML("afterbegin", html);
				break;
			case "inner":
			default:
				target.innerHTML = html;
		}
	}

	const reactiveKeyPattern = /^!?[a-z0-9_.-]+$/i;
	function parseReactiveKey(raw) {
		if (typeof raw !== "string") return undefined;
		const value = raw.trim();
		if (!reactiveKeyPattern.test(value)) return undefined;
		const negated = value.startsWith("!");
		return { key: negated ? value.slice(1) : value, negated };
	}
	function isTruthySignal(value) {
		if (value === undefined || value === null || value === false) return false;
		if (typeof value === "string") return value.trim().length > 0;
		if (Array.isArray(value)) return value.length > 0;
		return true;
	}
	function updateReactiveBindings() {
		for (const element of document.querySelectorAll("[data-show]")) {
			const parsed = parseReactiveKey(element.getAttribute("data-show"));
			if (!parsed) continue;
			element.hidden = isTruthySignal(signals[parsed.key]) === parsed.negated;
		}
		for (const element of document.querySelectorAll("[data-enable-when]")) {
			const parsed = parseReactiveKey(element.getAttribute("data-enable-when"));
			if (!parsed || !("disabled" in element)) continue;
			element.disabled = isTruthySignal(signals[parsed.key]) === parsed.negated;
		}
		// Backend events stay inert even when a local signal would normally
		// enable their controls.
		for (const trigger of document.querySelectorAll("[data-event]")) {
			if ("disabled" in trigger) trigger.disabled = true;
		}
	}
	function setElementValue(element, value) {
		if (element instanceof HTMLInputElement) {
			if (element.type === "checkbox") element.checked = Boolean(value);
			else if (element.type === "radio") element.checked = element.value === String(value);
			else element.value = value == null ? "" : String(value);
			return;
		}
		if (element instanceof HTMLTextAreaElement) {
			element.value = value == null ? "" : String(value);
			return;
		}
		if (element instanceof HTMLSelectElement) {
			const values = new Set(Array.isArray(value) ? value.map(String) : [String(value)]);
			for (const option of element.options) option.selected = values.has(option.value);
		}
	}
	function readElementValue(element) {
		if (element instanceof HTMLInputElement) {
			if (element.type === "checkbox") return element.checked;
			if (element.type === "radio") return element.checked ? element.value : undefined;
			return element.value;
		}
		if (element instanceof HTMLTextAreaElement) return element.value;
		if (element instanceof HTMLSelectElement) {
			return element.multiple
				? [...element.selectedOptions].map((option) => option.value)
				: element.value;
		}
		return undefined;
	}
	function captureSignal(target) {
		if (!(target instanceof Element)) return;
		const element = target.closest("[data-signal]");
		if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) return;
		const key = element.getAttribute("data-signal");
		if (!key) return;
		const value = readElementValue(element);
		if (value === undefined) return;
		signals[key] = value;
		updateReactiveBindings();
	}

	for (const element of document.querySelectorAll("[data-signal]")) {
		const key = element.getAttribute("data-signal");
		if (key && Object.prototype.hasOwnProperty.call(signals, key)) {
			setElementValue(element, signals[key]);
		}
	}
	updateReactiveBindings();

	for (const trigger of document.querySelectorAll("[data-event]")) {
		if ("disabled" in trigger) trigger.disabled = true;
		trigger.setAttribute("aria-disabled", "true");
		trigger.setAttribute("title", "Unavailable in static export");
	}

	document.addEventListener("input", (event) => captureSignal(event.target), true);
	document.addEventListener("change", (event) => captureSignal(event.target), true);
	document.addEventListener("submit", (event) => event.preventDefault(), true);
	document.addEventListener("click", (event) => {
		if (event.target instanceof Element && event.target.closest("[data-event]")) event.preventDefault();
	}, true);
})();`;
