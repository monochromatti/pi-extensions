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
		"render",
		"read_signals",
		"wait_for_event",
		"Allowed selectors",
		"#root",
		"#status",
		"#sidebar",
		"#canvas-",
		"data-canvas-slot",
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
		"<mermaid-diagram>",
		"<code-block",
		"language=\"diff\"",
		"Styling rules",
		"Anti-patterns",
		"Worked example",
	]) {
		expectContains(skill, required);
	}
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
