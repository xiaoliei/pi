import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { anthropicModel, openAICompletionsModel, openAIResponsesModel } from "./fixtures.ts";

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

describe("Cache Retention", () => {
	const originalEnv = process.env.PI_CACHE_RETENTION;

	beforeEach(() => {
		delete process.env.PI_CACHE_RETENTION;
	});

	afterEach(() => {
		if (originalEnv !== undefined) {
			process.env.PI_CACHE_RETENTION = originalEnv;
		}
	});

	it("applies Anthropic cache_control markers with long retention", async () => {
		const model = anthropicModel("claude-haiku-4-5");
		const captured: unknown[] = [];
		const context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user" as const, content: "hello", timestamp: Date.now() }],
		};
		const stream = streamAnthropic(model, context, {
			apiKey: "test-key",
			cacheRetention: "long",
			onPayload: (payload) => {
				captured.push(payload);
				throw new PayloadCaptured();
			},
		});
		await stream.result().catch(() => {});
		expect(captured.length).toBeGreaterThan(0);
		const payload = captured[0] as { system?: Array<{ cache_control?: { type: string } }> };
		expect(payload.system?.[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
	});

	it("sends openai-completions prompt_cache_key with session affinity", async () => {
		const model = openAICompletionsModel("gpt-4o-mini");
		const captured: unknown[] = [];
		const context = {
			messages: [{ role: "user" as const, content: "hello", timestamp: Date.now() }],
		};
		const stream = streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			sessionId: "session-affinity",
			cacheRetention: "long",
			onPayload: (payload) => {
				captured.push(payload);
				throw new PayloadCaptured();
			},
		});
		await stream.result().catch(() => {});
		expect(captured.length).toBeGreaterThan(0);
		const payload = captured[0] as { prompt_cache_key?: string };
		expect(payload.prompt_cache_key).toBe("session-affinity");
	});

	it("sends openai-responses prompt_cache_key with session affinity", async () => {
		const model = openAIResponsesModel("gpt-5-mini");
		const captured: unknown[] = [];
		const context = {
			messages: [{ role: "user" as const, content: "hello", timestamp: Date.now() }],
		};
		const stream = streamOpenAIResponses(model, context, {
			apiKey: "test-key",
			sessionId: "session-affinity",
			cacheRetention: "long",
			onPayload: (payload) => {
				captured.push(payload);
				throw new PayloadCaptured();
			},
		});
		await stream.result().catch(() => {});
		expect(captured.length).toBeGreaterThan(0);
		const payload = captured[0] as { prompt_cache_key?: string };
		expect(payload.prompt_cache_key).toBe("session-affinity");
	});
});
