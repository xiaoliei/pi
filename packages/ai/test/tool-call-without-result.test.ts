import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { complete } from "../src/index.ts";
import type { Api, Context, Model, StreamOptions, Tool } from "../src/types.ts";
import { anthropicModel, openAICompletionsModel, openAIResponsesModel } from "./fixtures.ts";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

const calculateSchema = Type.Object({
	expression: Type.String({ description: "The mathematical expression to evaluate" }),
});
const calculateTool: Tool = {
	name: "calculate",
	description: "Evaluate mathematical expressions",
	parameters: calculateSchema,
};

const PROTOCOLS: Array<{ label: string; env: string; model: Model<Api> }> = [
	{ label: "Anthropic", env: "ANTHROPIC_API_KEY", model: anthropicModel("claude-haiku-4-5") },
	{ label: "OpenAI Completions", env: "OPENAI_API_KEY", model: openAICompletionsModel("gpt-4o-mini") },
	{ label: "OpenAI Responses", env: "OPENAI_API_KEY", model: openAIResponsesModel("gpt-5-mini") },
];

async function testToolCallWithoutResult<TApi extends Api>(model: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const context: Context = {
		systemPrompt: "You are a helpful assistant. Use the calculate tool when asked to perform calculations.",
		messages: [
			{ role: "user", content: "Please calculate 25 * 18 using the calculate tool.", timestamp: Date.now() },
		],
		tools: [calculateTool],
	};
	const firstResponse = await complete(model, context, options);
	context.messages.push(firstResponse);
	expect(firstResponse.stopReason, firstResponse.errorMessage).not.toBe("error");

	// Continue with a follow-up user message; the missing tool result must not 400.
	context.messages.push({ role: "user", content: "Just say hello.", timestamp: Date.now() });
	const followUp = await complete(model, context, options);
	expect(followUp.stopReason, followUp.errorMessage).not.toBe("error");
	expect(followUp.content.length).toBeGreaterThan(0);
}

describe("Retained Protocol Tool Call Without Result Tests", () => {
	for (const protocol of PROTOCOLS) {
		describe.skipIf(!process.env[protocol.env])(`${protocol.label} Provider`, () => {
			it("handles missing tool results", { retry: 3, timeout: 30000 }, async () => {
				await testToolCallWithoutResult(protocol.model);
			});
		});
	}
});
