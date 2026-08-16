/**
 * Shared model fixtures for the retained protocols. Built-in provider
 * catalogs are gone; tests construct endpoint-style models instead.
 */

import type { Api, Model } from "../src/types.ts";

export type FixtureApi = "anthropic-messages" | "openai-completions" | "openai-responses";

export function endpointModel<TApi extends FixtureApi>(
	api: TApi,
	id = "test-model",
	overrides: Partial<Model<TApi>> = {},
): Model<TApi> {
	return {
		id,
		name: id,
		api,
		provider: "test-endpoint",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		...overrides,
	};
}

export const FIXTURE_MODELS: Record<FixtureApi, Model<Api>> = {
	"anthropic-messages": endpointModel("anthropic-messages", "claude-test"),
	"openai-completions": endpointModel("openai-completions", "gpt-test"),
	"openai-responses": endpointModel("openai-responses", "gpt-test"),
};

export function anthropicModel(
	id: string,
	overrides: Partial<Model<"anthropic-messages">> = {},
): Model<"anthropic-messages"> {
	return endpointModel("anthropic-messages", id, {
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com/v1",
		reasoning: true,
		input: ["text", "image"],
		...overrides,
	});
}

export function openAICompletionsModel(
	id: string,
	overrides: Partial<Model<"openai-completions">> = {},
): Model<"openai-completions"> {
	return endpointModel("openai-completions", id, {
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		...overrides,
	});
}

export function openAIResponsesModel(
	id: string,
	overrides: Partial<Model<"openai-responses">> = {},
): Model<"openai-responses"> {
	return endpointModel("openai-responses", id, {
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		...overrides,
	});
}
