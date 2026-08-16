import { describe, expect, it } from "vitest";
import { getSupportedThinkingLevels } from "../src/models.ts";
import { anthropicModel } from "./fixtures.ts";

describe("getSupportedThinkingLevels", () => {
	it("includes max but not xhigh when only max is mapped", () => {
		const model = anthropicModel("claude-opus-4-6", { thinkingLevelMap: { max: "max" } });
		expect(getSupportedThinkingLevels(model)).toContain("max");
		expect(getSupportedThinkingLevels(model)).not.toContain("xhigh");
	});

	it("includes xhigh and max when both are mapped", () => {
		const model = anthropicModel("claude-opus-4-8", { thinkingLevelMap: { xhigh: "xhigh", max: "max" } });
		expect(getSupportedThinkingLevels(model)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model)).toContain("max");
	});

	it("reports only off for non-reasoning models", () => {
		const model = anthropicModel("plain", { reasoning: false });
		expect(getSupportedThinkingLevels(model)).toEqual(["off"]);
	});
});
