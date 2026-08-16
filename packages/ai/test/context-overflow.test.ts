/**
 * Test context overflow error handling across the retained protocols.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { complete } from "../src/index.ts";
import type { AssistantMessage, Context, Model, Usage } from "../src/types.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";
import { endpointModel, type FixtureApi } from "./fixtures.ts";

// Lorem ipsum paragraph for realistic token estimation
const LOREM_IPSUM = `Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. `;

function generateOverflowContent(contextWindow: number): string {
	const targetTokens = contextWindow + 10000;
	const targetChars = targetTokens * 4 * 1.5;
	const repetitions = Math.ceil(targetChars / LOREM_IPSUM.length);
	return LOREM_IPSUM.repeat(repetitions);
}

interface OverflowResult {
	provider: string;
	model: string;
	contextWindow: number;
	stopReason: string;
	errorMessage: string | undefined;
	usage: Usage;
	hasUsageData: boolean;
	response: AssistantMessage;
}

async function testContextOverflow(model: Model<any>, apiKey: string): Promise<OverflowResult> {
	const overflowContent = generateOverflowContent(model.contextWindow);
	const context: Context = {
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user", content: overflowContent, timestamp: Date.now() }],
	};
	const response = await complete(model, context, { apiKey });
	const hasUsageData = response.usage.input > 0 || response.usage.cacheRead > 0;
	return {
		provider: model.provider,
		model: model.id,
		contextWindow: model.contextWindow,
		stopReason: response.stopReason,
		errorMessage: response.errorMessage,
		usage: response.usage,
		hasUsageData,
		response,
	};
}

function logResult(result: OverflowResult) {
	console.log(`\n${result.provider} / ${result.model}:`);
	console.log(`  contextWindow: ${result.contextWindow}`);
	console.log(`  stopReason: ${result.stopReason}`);
	console.log(`  errorMessage: ${result.errorMessage}`);
	console.log(`  usage: ${JSON.stringify(result.usage)}`);
	console.log(`  hasUsageData: ${result.hasUsageData}`);
}

const PROTOCOLS: Array<{ api: FixtureApi; label: string; env: string; id: string }> = [
	{ api: "anthropic-messages", label: "Anthropic (API Key)", env: "ANTHROPIC_API_KEY", id: "claude-haiku-4-5" },
	{ api: "openai-completions", label: "OpenAI Completions", env: "OPENAI_API_KEY", id: "gpt-4o-mini" },
	{ api: "openai-responses", label: "OpenAI Responses", env: "OPENAI_API_KEY", id: "gpt-5-mini" },
];

beforeAll(() => {});

afterAll(() => {});

describe("Context overflow error handling", () => {
	for (const protocol of PROTOCOLS) {
		describe.skipIf(!process.env[protocol.env])(`${protocol.label}`, () => {
			it(`${protocol.id} - should detect overflow via isContextOverflow`, async () => {
				const model = endpointModel(protocol.api, protocol.id, { contextWindow: 16000 });
				const result = await testContextOverflow(model, process.env[protocol.env]!);
				logResult(result);

				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toBeDefined();
				expect(isContextOverflow(result.response, model.contextWindow)).toBe(true);
			}, 120000);
		});
	}
});
