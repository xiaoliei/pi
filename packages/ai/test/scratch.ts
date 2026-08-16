// Scratch script showing real-world use of the endpoint model API.
// Run from packages/ai: node test/scratch.ts
// Requires an API key configured via models.json or an env var.

import { endpointProvider } from "../src/endpoint-provider.ts";
import { knownModelMetadata } from "../src/known-models.ts";
import { createModels } from "../src/models.ts";
import type { Context } from "../src/types.ts";

// 1. Build an endpoint provider from a user-configured endpoint.
const endpoint = endpointProvider({
	id: "my-relay",
	name: "My Relay",
	baseUrl: "https://relay.example.com/v1",
	api: "openai-completions",
	apiKey: process.env.RELAY_API_KEY,
	models: [
		{
			id: "gpt-test",
			name: "GPT Test",
			api: "openai-completions",
			provider: "my-relay",
			baseUrl: "https://relay.example.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 16384,
		},
	],
});

// 2. Register it in a Models runtime.
const models = createModels();
models.setProvider(endpoint);

// 3. Discovery metadata fallback for unknown ids.
console.log("known-models lookup:", knownModelMetadata("gpt-test"));

const context: Context = {
	messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
};

const model = models.getModel("my-relay", "gpt-test");
if (model) {
	await models.completeSimple(model, context).then((message) => {
		console.log(message.content);
	});
}
