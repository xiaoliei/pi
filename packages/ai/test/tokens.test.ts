import { describe, expect, it } from "vitest";
import { stream } from "../src/index.ts";
import type { Api, Context, Model, StreamOptions } from "../src/types.ts";
import { anthropicModel, openAICompletionsModel, openAIResponsesModel } from "./fixtures.ts";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

const PROTOCOLS: Array<{ label: string; env: string; model: Model<Api> }> = [
	{ label: "Anthropic", env: "ANTHROPIC_API_KEY", model: anthropicModel("claude-sonnet-4-6") },
	{ label: "OpenAI Completions", env: "OPENAI_API_KEY", model: openAICompletionsModel("gpt-4o-mini") },
	{ label: "OpenAI Responses", env: "OPENAI_API_KEY", model: openAIResponsesModel("gpt-5.4-mini") },
];

async function testTokensOnAbort<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "Write a long poem with 20 stanzas about the beauty of nature.",
				timestamp: Date.now(),
			},
		],
		systemPrompt: "You are a helpful assistant.",
	};

	const controller = new AbortController();
	const response = stream(llm, context, { ...options, signal: controller.signal });

	let abortFired = false;
	let text = "";
	for await (const event of response) {
		if (!abortFired && (event.type === "text_delta" || event.type === "thinking_delta")) {
			text += event.delta;
			if (text.length >= 1000) {
				abortFired = true;
				controller.abort();
			}
		}
	}

	const msg = await response.result();
	expect(msg.stopReason).toBe("aborted");

	// OpenAI protocols only send usage in the final chunk, so aborted requests
	// report zero tokens; Anthropic reports usage early.
	if (llm.api === "openai-completions" || llm.api === "openai-responses") {
		expect(msg.usage.input).toBe(0);
		expect(msg.usage.output).toBe(0);
	} else {
		expect(msg.usage.totalTokens).toBeGreaterThan(0);
	}
}

describe("Retained Protocol Tokens On Abort Tests", () => {
	for (const protocol of PROTOCOLS) {
		describe.skipIf(!process.env[protocol.env])(`${protocol.label} Provider`, () => {
			it("reports token usage after abort", { retry: 3, timeout: 30000 }, async () => {
				await testTokensOnAbort(protocol.model);
			});
		});
	}
});
