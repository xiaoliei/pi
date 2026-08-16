import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { complete } from "../src/index.ts";
import type { Api, Context, Model, StreamOptions } from "../src/types.ts";
import { anthropicModel, openAICompletionsModel, openAIResponsesModel } from "./fixtures.ts";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

const emptySchema = Type.Object({});

const PROTOCOLS: Array<{ label: string; env: string; model: Model<Api> }> = [
	{ label: "Anthropic", env: "ANTHROPIC_API_KEY", model: anthropicModel("claude-haiku-4-5") },
	{ label: "OpenAI Completions", env: "OPENAI_API_KEY", model: openAICompletionsModel("gpt-4o-mini") },
	{ label: "OpenAI Responses", env: "OPENAI_API_KEY", model: openAIResponsesModel("gpt-5-mini") },
];

async function testEmojiInToolResults<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const context: Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [
			{ role: "user", content: "Use the test tool", timestamp: Date.now() },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "test_1", name: "test_tool", arguments: {} }],
				api: llm.api,
				provider: llm.provider,
				model: llm.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "test_1",
				toolName: "test_tool",
				content: [{ type: "text", text: "Result: 😀🎉🚀 中文测试 𝔘𝔫𝔦𝔠𝔬𝔡𝔢" }],
				isError: false,
				timestamp: Date.now(),
			},
			{ role: "user", content: "What did the tool return?", timestamp: Date.now() },
		],
		tools: [{ name: "test_tool", description: "Test tool", parameters: emptySchema }],
	};
	const response = await complete(llm, context, options);
	expect(response.stopReason, response.errorMessage).not.toBe("error");
	expect(response.content.length).toBeGreaterThan(0);
}

describe("Retained Protocol Unicode Surrogate Tests", () => {
	for (const protocol of PROTOCOLS) {
		describe.skipIf(!process.env[protocol.env])(`${protocol.label} Provider`, () => {
			it("handles emoji and unicode in tool results", { retry: 3, timeout: 30000 }, async () => {
				await testEmojiInToolResults(protocol.model);
			});
		});
	}
});
