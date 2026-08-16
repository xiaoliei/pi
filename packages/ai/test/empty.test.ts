import { describe, expect, it } from "vitest";
import { complete } from "../src/index.ts";
import type { Api, AssistantMessage, Model, StreamOptions, UserMessage } from "../src/types.ts";
import { endpointModel, type FixtureApi } from "./fixtures.ts";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

const PROTOCOLS: Array<{ api: FixtureApi; label: string; env: string; id: string }> = [
	{ api: "anthropic-messages", label: "Anthropic Messages", env: "ANTHROPIC_API_KEY", id: "claude-haiku-4-5" },
	{ api: "openai-completions", label: "OpenAI Completions", env: "OPENAI_API_KEY", id: "gpt-4o-mini" },
	{ api: "openai-responses", label: "OpenAI Responses", env: "OPENAI_API_KEY", id: "gpt-5-mini" },
];

async function testEmptyMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const emptyMessage: UserMessage = { role: "user", content: [], timestamp: Date.now() };
	const response = await complete(llm, { messages: [emptyMessage] }, options);
	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
	}
}

async function testEmptyStringMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const response = await complete(llm, { messages: [{ role: "user", content: "", timestamp: Date.now() }] }, options);
	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
	}
}

async function testWhitespaceOnlyMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const response = await complete(
		llm,
		{ messages: [{ role: "user", content: "   \n\t  ", timestamp: Date.now() }] },
		options,
	);
	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
	}
}

async function testEmptyAssistantMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const emptyAssistant: AssistantMessage = {
		role: "assistant",
		content: [],
		api: llm.api,
		provider: llm.provider,
		model: llm.id,
		usage: {
			input: 10,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const response = await complete(
		llm,
		{
			messages: [
				{ role: "user", content: "Hello, how are you?", timestamp: Date.now() },
				emptyAssistant,
				{ role: "user", content: "Please respond this time.", timestamp: Date.now() },
			],
		},
		options,
	);
	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
		expect(response.content.length).toBeGreaterThan(0);
	}
}

describe("Retained Protocol Empty Message Tests", () => {
	for (const protocol of PROTOCOLS) {
		describe.skipIf(!process.env[protocol.env])(`${protocol.label} Empty Messages`, () => {
			const llm = endpointModel(protocol.api, protocol.id);

			it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
				await testEmptyMessage(llm);
			});

			it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
				await testEmptyStringMessage(llm);
			});

			it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
				await testWhitespaceOnlyMessage(llm);
			});

			it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
				await testEmptyAssistantMessage(llm);
			});
		});
	}
});
