import assert from "node:assert/strict";
import test from "node:test";
import { CANVAS_HELPER_CLASSES, lintCanvasHtml } from "../src/lint.ts";
import { createCanvasSession } from "../src/session.ts";
import { renderToCanvas } from "../src/render.ts";

test("9.1 clean recipe-shaped html produces no warnings", () => {
	const warnings = lintCanvasHtml({
		selector: "#root",
		html: `<section class="card" id="canvas-scope" data-canvas-slot="scope">
			<h3>Scope <span class="badge warning">draft</span></h3>
			<markdown-block>**In**: auth. **Out**: SSO.</markdown-block>
			<label class="field">Notes<textarea data-signal="feedback.section.scope"></textarea></label>
			<div class="toolbar">
				<button data-event="attention:revise_scope" data-enable-when="feedback.section.scope">Revise</button>
				<button data-event="checkpoint:approve_scope">Approve</button>
			</div>
		</section>`,
	});
	assert.deepEqual(warnings, []);
});

test("9.2 unknown classes are flagged with the allowed vocabulary", () => {
	const warnings = lintCanvasHtml({
		selector: "#root",
		html: `<div class="card panel-hero"><p class="muted">ok</p></div>`,
	});
	assert.equal(warnings.length, 1);
	assert.match(warnings[0]!, /"panel-hero"/);
	assert.match(warnings[0]!, new RegExp(CANVAS_HELPER_CLASSES.join(", ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("9.3 class-like text inside component bodies is not flagged", () => {
	const warnings = lintCanvasHtml({
		selector: "#root",
		html: `<code-block language="html">&lt;div class="hero-banner"&gt;<span class="x">y</span>&lt;/div&gt;</code-block>`,
	});
	assert.deepEqual(warnings, []);
});

test("9.4 stripped styles and scripts are reported", () => {
	const warnings = lintCanvasHtml({
		selector: "#root",
		html: `<style>.x{color:red}</style><div style="color: red"><script>alert(1)</script></div>`,
	});
	assert.equal(warnings.some((warning) => /inline styles/i.test(warning)), true);
	assert.equal(warnings.some((warning) => /<script>/.test(warning)), true);
});

test("9.5 prose-heavy html suggests markdown-block", () => {
	const warnings = lintCanvasHtml({
		selector: "#root",
		html: `<p>one</p><p>two</p><p>three</p>`,
	});
	assert.equal(warnings.some((warning) => /markdown-block/.test(warning)), true);
});

test("9.6 overlong #status is flagged; same text in #root is fine", () => {
	const longLine = `<p>${"status ".repeat(30)}</p>`;
	assert.equal(
		lintCanvasHtml({ selector: "#status", html: longLine }).some((warning) => /#status/.test(warning)),
		true,
	);
	assert.deepEqual(lintCanvasHtml({ selector: "#root", html: longLine }), []);
});

test("9.7 dead controls and dead buttons are flagged", () => {
	const warnings = lintCanvasHtml({
		selector: "#sidebar",
		html: `<textarea placeholder="notes"></textarea><button>Send</button>`,
	});
	assert.equal(warnings.some((warning) => /data-signal/.test(warning)), true);
	assert.equal(warnings.some((warning) => /data-event/.test(warning)), true);
});

test("9.8 malformed reactive keys are flagged", () => {
	const warnings = lintCanvasHtml({
		selector: "#root",
		html: `<div data-show="feedback.global == 'x'">hint</div>`,
	});
	assert.equal(warnings.length, 1);
	assert.match(warnings[0]!, /data-show/);
});

test("9.9 render result carries slots and append-streak warning surfaces via renderToCanvas", () => {
	const session = createCanvasSession({ token: "lint" });

	const first = renderToCanvas(session, {
		selector: "#root",
		html: `<section data-canvas-slot="scope">scope</section>`,
	});
	assert.equal(first.ok, true);
	if (first.ok) {
		assert.deepEqual(first.slots, ["root", "scope", "sidebar", "status"]);
		assert.equal(first.warnings, undefined);
	}

	let last: ReturnType<typeof renderToCanvas> | undefined;
	for (let i = 0; i < 3; i++) {
		last = renderToCanvas(session, { selector: "#root", html: "<section>more</section>", mode: "append" });
	}
	assert.equal(last?.ok, true);
	if (last?.ok) {
		assert.equal(last.warnings?.some((warning) => /appended to #root/.test(warning)), true);
	}

	// A non-append render resets the streak.
	const reset = renderToCanvas(session, { selector: "#root", html: "<section>fresh</section>" });
	assert.equal(reset.ok, true);
	if (reset.ok) {
		assert.equal(reset.warnings, undefined);
	}
});

test("9.10 taste preflight flags repetitive cards, long actions, and heading jumps", () => {
	const warnings = lintCanvasHtml({
		selector: "#root",
		html: `<h1>Review</h1><h3>Details</h3>
			<section class="card">one</section><section class="card">two</section>
			<section class="card">three</section><section class="card">four</section>
			<button data-event="checkpoint:continue">Approve this entire implementation and continue now</button>`,
	});
	assert.equal(warnings.some((warning) => /4 cards/.test(warning)), true);
	assert.equal(warnings.some((warning) => /Long button label/.test(warning)), true);
	assert.equal(warnings.some((warning) => /Heading hierarchy/.test(warning)), true);
});

test("9.11 large root documents without slots are flagged", () => {
	const warnings = lintCanvasHtml({ selector: "#root", html: `<markdown-block>${"detail ".repeat(400)}</markdown-block>` });
	assert.equal(warnings.some((warning) => /named data-canvas-slot/.test(warning)), true);
	assert.equal(
		lintCanvasHtml({ selector: "#root", html: `<section data-canvas-slot="detail">${"detail ".repeat(400)}</section>` }).some(
			(warning) => /named data-canvas-slot/.test(warning),
		),
		false,
	);
});
