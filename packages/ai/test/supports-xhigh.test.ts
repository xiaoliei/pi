import { describe, expect, it } from "vitest";
import { getSupportedThinkingLevels } from "../src/models.ts";
import { anthropicModel } from "./fixtures.ts";

describe("getSupportedThinkingLevels", () => {
	it("always includes xhigh and max for reasoning models without a map", () => {
		const model = anthropicModel("claude-opus-4-6");
		expect(getSupportedThinkingLevels(model)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model)).toContain("max");
	});

	it("includes xhigh and max when both are mapped", () => {
		const model = anthropicModel("claude-opus-4-8", { thinkingLevelMap: { xhigh: "xhigh", max: "max" } });
		expect(getSupportedThinkingLevels(model)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model)).toContain("max");
	});

	it("hides xhigh when explicitly mapped to null", () => {
		const model = anthropicModel("claude-opus-4-6", { thinkingLevelMap: { xhigh: null } });
		expect(getSupportedThinkingLevels(model)).not.toContain("xhigh");
	});

	it("reports only off for non-reasoning models", () => {
		const model = anthropicModel("plain", { reasoning: false });
		expect(getSupportedThinkingLevels(model)).toEqual(["off"]);
	});
});
