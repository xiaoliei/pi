import { describe, expect, it } from "vitest";
import { complete } from "../src/index.ts";
import type { Api, Context, Model, StreamOptions, Usage } from "../src/types.ts";
import { anthropicModel, openAICompletionsModel, openAIResponsesModel } from "./fixtures.ts";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

const LONG_SYSTEM_PROMPT = `You are a helpful assistant. Be concise in your responses.

Here is some additional context that makes this system prompt long enough to trigger caching:

${Array(50)
	.fill(
		"Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.",
	)
	.join("\n\n")}

Remember: Always be helpful and concise.`;

const PROTOCOLS: Array<{ label: string; env: string; model: Model<Api> }> = [
	{ label: "Anthropic", env: "ANTHROPIC_API_KEY", model: anthropicModel("claude-haiku-4-5") },
	{ label: "OpenAI Completions", env: "OPENAI_API_KEY", model: openAICompletionsModel("gpt-4o-mini") },
	{ label: "OpenAI Responses", env: "OPENAI_API_KEY", model: openAIResponsesModel("gpt-5-mini") },
];

async function testTotalTokensWithCache<TApi extends Api>(
	llm: Model<TApi>,
	options: StreamOptionsWithExtras = {},
): Promise<{ first: Usage; second: Usage }> {
	const context1: Context = {
		systemPrompt: LONG_SYSTEM_PROMPT,
		messages: [{ role: "user", content: "What is 2 + 2? Reply with just the number.", timestamp: Date.now() }],
	};
	const response1 = await complete(llm, context1, options);
	expect(response1.stopReason).toBe("stop");
	expect(response1.usage.totalTokens).toBeGreaterThan(0);

	const context2: Context = {
		systemPrompt: LONG_SYSTEM_PROMPT,
		messages: [...context1.messages, response1, { role: "user", content: "And 3 + 5?", timestamp: Date.now() }],
	};
	const response2 = await complete(llm, context2, options);
	expect(response2.stopReason).toBe("stop");
	expect(response2.usage.totalTokens).toBeGreaterThan(0);

	return { first: response1.usage, second: response2.usage };
}

describe("Retained Protocol totalTokens Tests", () => {
	for (const protocol of PROTOCOLS) {
		describe.skipIf(!process.env[protocol.env])(`${protocol.label} Provider`, () => {
			it("reports totalTokens with cache", { retry: 3, timeout: 30000 }, async () => {
				const { first, second } = await testTotalTokensWithCache(protocol.model);
				expect(second.input).toBeGreaterThan(0);
				expect(first.totalTokens).toBe(first.input + first.output + first.cacheRead + first.cacheWrite);
				expect(second.totalTokens).toBe(second.input + second.output + second.cacheRead + second.cacheWrite);
			});
		});
	}
});
