# @earendil-works/pi-ai

Unified LLM API for the pi coding agent: protocol implementations, token/cost
tracking, and a runtime `Models` collection. There is no built-in provider
catalog — providers are user-configured endpoints (baseUrl + API key +
protocol), typically created with `/connect` in the coding-agent TUI and
stored in `<agentDir>/models.json`.

## Installation

```sh
npm install @earendil-works/pi-ai
```

## Quick Start

Build a provider from a configured endpoint:

```ts
import { createModels, endpointProvider } from "@earendil-works/pi-ai";

const models = createModels();
models.setProvider(
	endpointProvider({
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
	}),
);

const model = models.getModel("my-relay", "gpt-test")!;
const response = await models.completeSimple(model, {
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
});
```

## Protocols

Three protocols are supported:

- `openai-completions` — OpenAI chat completions
- `openai-responses` — OpenAI Responses API
- `anthropic-messages` — Anthropic Messages API

Each protocol module exports `stream`, `streamSimple`, and lazy wrappers
(`anthropicMessagesApi()`, `openAICompletionsApi()`, `openAIResponsesApi()`).
Compatibility quirks (thinking formats, session affinity, cache markers) are
auto-detected from the endpoint baseUrl and can be overridden per endpoint or
per model through `compat`.

## Model Discovery

Endpoints that expose `GET {baseUrl}/models` can be probed:

```ts
import { discoverEndpointModels } from "@earendil-works/pi-ai";

const models = await discoverEndpointModels({
	api: "openai-completions",
	baseUrl: "https://relay.example.com/v1",
	apiKey: process.env.RELAY_API_KEY,
});
```

Imported models get metadata from the hand-maintained `known-models.ts` table
(context window, max tokens, reasoning, input modalities); unknown ids fall
back to conservative defaults and cost zero until edited.

## Auth

API keys only. No OAuth. A provider's `auth.apiKey` resolves the configured
key (a models.json literal, `$ENV_VAR` interpolation, or `!command`
execution); keyless local servers (llama.cpp, vLLM) simply carry no auth.

## Global API Dispatch

`api-registry.ts` (exported from the package root) provides
`registerApiProvider`, `getApiProvider`, `unregisterApiProviders`,
`registerFauxProvider`, and the global `stream`/`streamSimple`/`complete`/
`completeSimple` functions. The three built-in protocols are pre-registered;
`registerFauxProvider()` is the test double used by the coding-agent harness.

## Images

The `ImagesModels` collection and `createImagesProvider` remain available for
extensions that register image APIs (`registerImagesApiProvider`). No built-in
image provider or catalog ships with the package.

## Links

- `packages/coding-agent` — the CLI/TUI that uses this package; run `/connect`
  to add endpoints.
- `docs/plans/2026-07-29-user-endpoints-design.md` — the design that replaced
  the built-in provider catalog.
