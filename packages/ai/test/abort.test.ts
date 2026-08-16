import { describe, expect, it } from "vitest";
import { complete, stream } from "../src/index.ts";
import type { Api, Context, Model, StreamOptions } from "../src/types.ts";
import { endpointModel, type FixtureApi } from "./fixtures.ts";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

const PROTOCOLS: Array<{
	api: FixtureApi;
	label: string;
	env: string;
	id: string;
	options?: StreamOptionsWithExtras;
}> = [
	{
		api: "anthropic-messages",
		label: "Anthropic Messages",
		env: "ANTHROPIC_API_KEY",
		id: "claude-haiku-4-5",
	},
	{
		api: "openai-completions",
		label: "OpenAI Completions",
		env: "OPENAI_API_KEY",
		id: "gpt-4o-mini",
	},
	{
		api: "openai-responses",
		label: "OpenAI Responses",
		env: "OPENAI_API_KEY",
		id: "gpt-5-mini",
	},
];

async function testAbortSignal<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "What is 15 + 27? Think step by step. Then list 50 first names.",
				timestamp: Date.now(),
			},
		],
		systemPrompt: "You are a helpful assistant.",
	};

	let abortFired = false;
	let text = "";
	const controller = new AbortController();
	const response = await stream(llm, context, { ...options, signal: controller.signal });
	for await (const event of response) {
		if (abortFired) return;
		if (event.type === "text_delta" || event.type === "thinking_delta") {
			text += event.delta;
		}
		if (text.length >= 50) {
			controller.abort();
			abortFired = true;
		}
	}
	const msg = await response.result();

	// If we get here without throwing, the abort didn't work
	expect(msg.stopReason).toBe("aborted");
	expect(msg.content.length).toBeGreaterThan(0);

	context.messages.push(msg);
	context.messages.push({
		role: "user",
		content: "Please continue, but only generate 5 names.",
		timestamp: Date.now(),
	});

	const followUp = await complete(llm, context, options);
	expect(followUp.stopReason).toBe("stop");
	expect(followUp.content.length).toBeGreaterThan(0);
}

async function testImmediateAbort<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const controller = new AbortController();
	controller.abort();

	const context: Context = {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};

	const response = await complete(llm, context, { ...options, signal: controller.signal });
	expect(response.stopReason).toBe("aborted");
}

async function testAbortThenNewMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const controller = new AbortController();
	controller.abort();

	const context: Context = {
		messages: [{ role: "user", content: "Hello, how are you?", timestamp: Date.now() }],
	};

	const abortedResponse = await complete(llm, context, { ...options, signal: controller.signal });
	expect(abortedResponse.stopReason).toBe("aborted");
	expect(abortedResponse.content.length).toBe(0);

	context.messages.push(abortedResponse);
	context.messages.push({
		role: "user",
		content: "What is 2 + 2?",
		timestamp: Date.now(),
	});

	const followUp = await complete(llm, context, options);
	expect(followUp.stopReason).toBe("stop");
	expect(followUp.content.length).toBeGreaterThan(0);
}

describe("Retained Protocol Abort Tests", () => {
	for (const protocol of PROTOCOLS) {
		describe.skipIf(!process.env[protocol.env])(`${protocol.label} Provider Abort`, () => {
			const llm = endpointModel(protocol.api, protocol.id);

			it("should abort mid-stream", { retry: 3 }, async () => {
				await testAbortSignal(llm, protocol.options);
			});

			it("should handle immediate abort", { retry: 3 }, async () => {
				await testImmediateAbort(llm, protocol.options);
			});

			it("should handle abort then new message", { retry: 3 }, async () => {
				await testAbortThenNewMessage(llm, protocol.options);
			});
		});
	}
});
