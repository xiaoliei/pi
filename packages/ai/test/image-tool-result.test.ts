import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { complete } from "../src/index.ts";
import type { Api, Context, Model, StreamOptions, Tool } from "../src/types.ts";
import { anthropicModel, openAICompletionsModel, openAIResponsesModel } from "./fixtures.ts";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const testImage = readFileSync(join(__dirname, "data", "red-circle.png")).toString("base64");

const PROTOCOLS: Array<{ label: string; env: string; model: Model<Api>; options?: StreamOptionsWithExtras }> = [
	{
		label: "Anthropic (claude-haiku-4-5)",
		env: "ANTHROPIC_API_KEY",
		model: anthropicModel("claude-haiku-4-5", { input: ["text", "image"] }),
	},
	{
		label: "OpenAI Completions (gpt-4o-mini)",
		env: "OPENAI_API_KEY",
		model: openAICompletionsModel("gpt-4o-mini", { input: ["text", "image"] }),
	},
	{
		label: "OpenAI Responses (gpt-5-mini)",
		env: "OPENAI_API_KEY",
		model: openAIResponsesModel("gpt-5-mini", { input: ["text", "image"] }),
	},
];

const getImageTool: Tool = {
	name: "get_circle_with_description",
	description: "Returns a red circle image with a short text description.",
	parameters: { type: "object", properties: {} },
};

async function verifyToolResultImages<TApi extends Api>(model: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const context: Context = {
		systemPrompt: "You are a helpful assistant that uses tools.",
		messages: [
			{ role: "user", content: "Use the tool and describe what you see.", timestamp: Date.now() },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "tool_1", name: getImageTool.name, arguments: {} }],
				api: model.api,
				provider: model.provider,
				model: model.id,
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
				toolCallId: "tool_1",
				toolName: getImageTool.name,
				content: [
					{ type: "text", text: "Here is the image:" },
					{ type: "image", mimeType: "image/png", data: testImage },
				],
				isError: false,
				timestamp: Date.now(),
			},
			{ role: "user", content: "What color is the circle?", timestamp: Date.now() },
		],
		tools: [getImageTool],
	};
	const response = await complete(model, context, options);
	expect(response.stopReason, response.errorMessage).not.toBe("error");
	const responseText = response.content
		.map((block) => (block.type === "text" ? block.text : ""))
		.join(" ")
		.toLowerCase();
	expect(responseText).toContain("red");
	expect(responseText).toContain("circle");
}

describe("Retained Protocol Tool Result Images", () => {
	for (const protocol of PROTOCOLS) {
		describe.skipIf(!process.env[protocol.env])(`${protocol.label}`, () => {
			it(
				"passes tool result images through and the model describes them",
				{ retry: 3, timeout: 30000 },
				async () => {
					await verifyToolResultImages(protocol.model, protocol.options);
				},
			);
		});
	}
});
