import { describe, expect, it } from "vitest";
import { getCompat } from "../src/api/openai-completions.ts";
import type { Model, OpenAICompletionsCompat } from "../src/types.ts";

function buildModel(id: string, baseUrl = "https://relay.example.com/v1"): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "custom-relay",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

describe("model-name compat layer (detectCompat family inference)", () => {
	it("disables the developer role for non-OpenAI families on unknown endpoints", () => {
		for (const id of [
			"glm-5.2",
			"deepseek-v4",
			"qwen3-max",
			"kimi-k2",
			"grok-4",
			"claude-opus-4.6",
			"zai/glm-5",
			"minimax-m2",
			"step-3.5-flash",
		]) {
			expect(getCompat(buildModel(id)).supportsDeveloperRole, id).toBe(false);
		}
	});

	it("keeps the developer role for OpenAI reasoning models on unknown endpoints", () => {
		for (const id of ["gpt-5.2", "o3-pro", "gpt-4.1", "openai/gpt-5.2", "codex-mini"]) {
			expect(getCompat(buildModel(id)).supportsDeveloperRole, id).toBe(true);
		}
	});

	it("only infers the developer-role flag, never a thinking format", () => {
		// glm on an unknown relay: the relay speaks OpenAI dialect (tested against
		// api.unself.cn: reasoning_effort passes through), so the family layer
		// must not force the zai thinking format.
		const compat = getCompat(buildModel("glm-5.2"));
		expect(compat.thinkingFormat).toBe("openai");
		expect(compat.supportsReasoningEffort).toBe(true);
		expect(compat.maxTokensField).toBe("max_completion_tokens");
	});

	it("known endpoint compat still wins over model-name inference", () => {
		// zai endpoint with an OpenAI-ish id: endpoint layer decides.
		const compat = getCompat(buildModel("gpt-5.2", "https://api.z.ai/v1"));
		expect(compat.supportsDeveloperRole).toBe(false);
		expect(compat.thinkingFormat).toBe("zai");
	});

	it("explicit model compat overrides family inference", () => {
		const compatOverride: OpenAICompletionsCompat = { supportsDeveloperRole: true };
		expect(getCompat({ ...buildModel("glm-5.2"), compat: compatOverride }).supportsDeveloperRole).toBe(true);
	});

	it("unknown model families keep the OpenAI baseline", () => {
		const compat = getCompat(buildModel("totally-unknown-model"));
		expect(compat.supportsDeveloperRole).toBe(true);
		expect(compat.thinkingFormat).toBe("openai");
	});
});
