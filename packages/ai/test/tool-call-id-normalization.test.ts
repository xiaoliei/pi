import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { completeSimple } from "../src/index.ts";
import type { AssistantMessage, Message, Tool, ToolResultMessage } from "../src/types.ts";
import { anthropicModel, openAIResponsesModel } from "./fixtures.ts";

const echoToolSchema = Type.Object({
	message: Type.String({ description: "Message to echo back" }),
});
const echoTool: Tool<typeof echoToolSchema> = {
	name: "echo",
	description: "Echo back the provided message",
	parameters: echoToolSchema,
};

describe.skipIf(!process.env.OPENAI_API_KEY || !process.env.ANTHROPIC_API_KEY)("Tool call ID normalization", () => {
	it("converts OpenAI-style tool call ids for Anthropic continuation", { retry: 2 }, async () => {
		const openaiModel = openAIResponsesModel("gpt-5-mini");
		const anthropic = anthropicModel("claude-haiku-4-5");

		const userMessage: Message = {
			role: "user",
			content: "Use the echo tool with message 'hello'.",
			timestamp: Date.now(),
		};
		const first = await completeSimple(
			openaiModel,
			{ messages: [userMessage], tools: [echoTool] },
			{ apiKey: process.env.OPENAI_API_KEY, reasoning: "low" },
		);
		expect(first.stopReason, first.errorMessage).not.toBe("error");
		expect(first.content.some((block) => block.type === "toolCall")).toBe(true);

		const toolCall = first.content.find((block) => block.type === "toolCall");
		if (!toolCall || toolCall.type !== "toolCall") throw new Error("Expected a tool call");
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: "echoed: hello" }],
			isError: false,
			timestamp: Date.now(),
		};

		const followUp: Message = {
			role: "user",
			content: "Say hello to confirm.",
			timestamp: Date.now(),
		};
		const second = await completeSimple(
			anthropic,
			{
				messages: [userMessage, first as AssistantMessage, toolResult, followUp],
				tools: [echoTool],
			},
			{ apiKey: process.env.ANTHROPIC_API_KEY },
		);
		expect(second.stopReason, second.errorMessage).not.toBe("error");
		expect(second.content.length).toBeGreaterThan(0);
	});
});
