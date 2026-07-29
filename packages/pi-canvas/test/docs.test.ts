import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

function readSkill(): string {
	return readFileSync(new URL("../skills/canvas/SKILL.md", import.meta.url), "utf8");
}

function readReadme(): string {
	return readFileSync(new URL("../README.md", import.meta.url), "utf8");
}

function expectContains(text: string, needle: string): void {
	assert.match(text, new RegExp(escapeRegExp(needle), "i"));
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("7.1 SKILL.md documents required canvas guidance sections", () => {
	const skill = readSkill();

	for (const required of [
		"When to use",
		"Mental model",
		"Tool reference",
		"canvas_render",
		"canvas_read_signals",
		"canvas_wait_for_event",
		"Allowed selectors",
		"#root",
		"#status",
		"#sidebar",
		"#canvas-",
		"data-canvas-slot",
		"data-signal",
		"Render modes",
		"inner",
		"outer",
		"append",
		"prepend",
		"Event model",
		"Quiet",
		"attention",
		"checkpoint",
		"Signal naming",
		"Snippets",
		"<markdown-block>",
		"<mermaid-diagram>",
		"<code-block",
		"language=\"diff\"",
		"Styling rules",
		"Anti-patterns",
		"Worked example",
	]) {
		expectContains(skill, required);
	}

	// Regression: the client only reads data-signal; documenting data-bind
	// produced dead UI that silently synced nothing.
	assert.doesNotMatch(skill, /data-bind/);
});

test("7.3 README documents install/use, /canvas, security policy, tests, and MVP demo", () => {
	const readme = readReadme();

	for (const required of [
		"Install",
		"Use",
		"/canvas",
		"Security",
		"Network policy",
		"Tests",
		"MVP demo script",
	]) {
		expectContains(readme, required);
	}
});

test("7.5 README MVP demo script matches acceptance flow at high level", () => {
	const readme = readReadme();

	for (const required of [
		"install",
		"/canvas",
		"browser opens",
		"URL",
		"empty-state",
		"spec planning",
		"renders scaffold",
		"Mermaid",
		"diff",
		"section feedback",
		"concise chat",
		"targeted render",
		"create `SPEC.md`",
		"writes final file",
	]) {
		expectContains(readme, required);
	}
});

test("10.3 SKILL.md teaches compression, selection comments, and decision-only controls", () => {
	const skill = readSkill();

	for (const required of [
		"Compression playbook",
		"Selection comments (built in)",
		"Decision points, not feedback prompts",
		"comments",
		"choice.",
	]) {
		expectContains(skill, required);
	}

	// Regression: the old recipes taught a generic feedback textarea everywhere.
	assert.doesNotMatch(skill, /data-signal="feedback\./);
});

test("10.4 README documents selection comments and reading-load lint rules", () => {
	const readme = readReadme();

	for (const required of ["Selection comments", "Canvas comment", "Reading-load rules"]) {
		expectContains(readme, required);
	}
});
