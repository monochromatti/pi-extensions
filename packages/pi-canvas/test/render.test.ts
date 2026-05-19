import assert from "node:assert/strict";
import test from "node:test";
import { createCanvasSession } from "../src/session.ts";
import { getQueuedPatches, renderToCanvas, subscribeToPatches } from "../src/render.ts";

test("4.1 render(#root, html) queues patch, emits patch, removes empty-state only first root render", () => {
	const session = createCanvasSession({ token: "test-token" });
	const emitted: ReturnType<typeof getQueuedPatches> = [];
	const unsubscribe = subscribeToPatches(session, (patch) => emitted.push(patch));

	const first = renderToCanvas(session, { selector: "#root", html: "<section>Draft v1</section>" });
	const second = renderToCanvas(session, { selector: "#root", html: "<section>Draft v2</section>" });
	unsubscribe();

	assert.equal(first.ok, true);
	assert.equal(second.ok, true);

	const queued = getQueuedPatches(session);
	assert.equal(queued.length, 3);

	assert.equal(queued[0]?.selector, "#canvas-empty-state");
	assert.equal(queued[0]?.mode, "outer");
	assert.equal(queued[0]?.html, "");

	assert.equal(queued[1]?.selector, "#root");
	assert.equal(queued[1]?.mode, "inner");
	assert.equal(queued[1]?.html, "<section>Draft v1</section>");

	assert.equal(queued[2]?.selector, "#root");
	assert.equal(queued[2]?.mode, "inner");
	assert.equal(queued[2]?.html, "<section>Draft v2</section>");

	assert.deepEqual(
		emitted.map((patch) => ({ selector: patch.selector, mode: patch.mode, html: patch.html })),
		[
			{ selector: "#canvas-empty-state", mode: "outer", html: "" },
			{ selector: "#root", mode: "inner", html: "<section>Draft v1</section>" },
			{ selector: "#root", mode: "inner", html: "<section>Draft v2</section>" },
		],
	);
});

test("4.3 render modes inner/outer/append/prepend produce distinct payload semantics", () => {
	const session = createCanvasSession({ token: "test-token" });

	renderToCanvas(session, { selector: "#status", html: "<p>inner</p>" });
	renderToCanvas(session, { selector: "#status", html: "<p>outer</p>", mode: "outer" });
	renderToCanvas(session, { selector: "#status", html: "<p>append</p>", mode: "append" });
	renderToCanvas(session, { selector: "#status", html: "<p>prepend</p>", mode: "prepend" });

	const statusPatches = getQueuedPatches(session).filter((patch) => patch.selector === "#status");
	assert.equal(statusPatches.length, 4);
	assert.deepEqual(
		statusPatches.map((patch) => ({ mode: patch.mode, html: patch.html })),
		[
			{ mode: "inner", html: "<p>inner</p>" },
			{ mode: "outer", html: "<p>outer</p>" },
			{ mode: "append", html: "<p>append</p>" },
			{ mode: "prepend", html: "<p>prepend</p>" },
		],
	);
});

test("4.5/4.6 selector validation allows built-ins + canvas selectors and tracks declared data slots", () => {
	const session = createCanvasSession({ token: "test-token" });

	assert.equal(renderToCanvas(session, { selector: "#root", html: "<div>ok</div>" }).ok, true);
	assert.equal(renderToCanvas(session, { selector: "#status", html: "<div>ok</div>" }).ok, true);
	assert.equal(renderToCanvas(session, { selector: "#sidebar", html: "<div>ok</div>" }).ok, true);
	assert.equal(renderToCanvas(session, { selector: "#canvas-timeline", html: "<div>ok</div>" }).ok, true);
	assert.equal(renderToCanvas(session, { selector: "[data-canvas-slot]", html: "<div>ok</div>" }).ok, true);

	renderToCanvas(session, {
		selector: "#root",
		html: "<section data-canvas-slot=\"review\">review</section>",
	});
	assert.equal(renderToCanvas(session, { selector: "[data-canvas-slot=\"review\"]", html: "<p>ok</p>" }).ok, true);

	const rejectTag = renderToCanvas(session, { selector: "div", html: "<p>bad</p>" });
	assert.deepEqual(rejectTag, { ok: false, error: "selector_not_allowed" });
	const rejectArbitraryId = renderToCanvas(session, { selector: "#notes", html: "<p>bad</p>" });
	assert.deepEqual(rejectArbitraryId, { ok: false, error: "selector_not_allowed" });
	const rejectUnknownSlot = renderToCanvas(session, { selector: "[data-canvas-slot=\"missing\"]", html: "<p>bad</p>" });
	assert.deepEqual(rejectUnknownSlot, { ok: false, error: "selector_not_allowed" });
});

test("4.7/4.8 render sanitizes dangerous html and blocks disallowed remote assets", () => {
	const session = createCanvasSession({ token: "test-token" });

	const cleaned = renderToCanvas(session, {
		selector: "#status",
		html: "<div onclick=\"alert(1)\"><script>alert(2)</script><a href=\"javascript:alert(3)\">x</a><img src=\"https://cdn.jsdelivr.net/x.png\"></div>",
	});
	assert.equal(cleaned.ok, true);
	if (cleaned.ok) {
		const html = cleaned.patches[0]?.html ?? "";
		assert.equal(html.includes("<script"), false);
		assert.equal(/\son[a-z]+\s*=/.test(html), false);
		assert.equal(html.toLowerCase().includes("javascript:"), false);
	}

	const blocked = renderToCanvas(session, {
		selector: "#status",
		html: "<img src=\"https://evil.example/x.png\">",
	});
	assert.deepEqual(blocked, { ok: false, error: "disallowed_remote_asset" });
});
