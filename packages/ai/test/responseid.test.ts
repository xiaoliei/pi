import { describe, expect, it } from "vitest";
import { complete } from "../src/index.ts";
import type { Api, Context, Model, StreamOptions } from "../src/types.ts";
import { anthropicModel, openAICompletionsModel, openAIResponsesModel } from "./fixtures.ts";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

const PROTOCOLS: Array<{ label: string; env: string; model: Model<Api> }> = [
	{ label: "Anthropic", env: "ANTHROPIC_API_KEY", model: anthropicModel("claude-haiku-4-5") },
	{ label: "OpenAI Completions", env: "OPENAI_API_KEY", model: openAICompletionsModel("gpt-4o-mini") },
	{ label: "OpenAI Responses", env: "OPENAI_API_KEY", model: openAIResponsesModel("gpt-5-mini") },
];

async function expectResponseId<TApi extends Api>(model: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const context: Context = {
		systemPrompt: "You are a helpful assistant. Be concise.",
		messages: [{ role: "user", content: "Reply with exactly: response id test", timestamp: Date.now() }],
	};
	const response = await complete(model, context, options);
	expect(response.stopReason, response.errorMessage).not.toBe("error");
	expect(response.responseId).toBeTruthy();
	expect(typeof response.responseId).toBe("string");
}

describe("responseId E2E Tests", () => {
	for (const protocol of PROTOCOLS) {
		describe.skipIf(!process.env[protocol.env])(`${protocol.label} Provider`, () => {
			it("should expose responseId", { retry: 3, timeout: 30000 }, async () => {
				await expectResponseId(protocol.model);
			});
		});
	}
});
