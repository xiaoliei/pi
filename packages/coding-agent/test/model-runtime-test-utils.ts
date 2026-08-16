import { type Api, type CredentialStore, fauxProvider, type Model, type ProviderAuth } from "@earendil-works/pi-ai";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";

const runtimes = new WeakMap<ModelRegistry, ModelRuntime>();
let sharedFauxModel: Model<Api> | undefined;

/** Shared faux model for tests that previously used catalog getModel(). */
export function testModel(): Model<Api> {
	if (!sharedFauxModel) {
		sharedFauxModel = fauxProvider({
			api: "faux",
			provider: "anthropic",
			models: [{ id: "test-model" }],
		}).getModel() as Model<Api>;
	}
	return sharedFauxModel;
}

function registerSharedFaux(runtime: ModelRuntime): void {
	const faux = fauxProvider({
		api: "faux",
		provider: "anthropic",
		models: [{ id: "test-model" }],
	});
	runtime.registerNativeProvider(faux.provider);
	// A small "test built-in" catalog so models.json overlay tests have a base
	// layer to merge with (the real catalog is gone by design).
	const catalogModel = (id: string, api: string, baseUrl: string, provider: string): Model<Api> => ({
		id,
		name: id,
		api: api as Api,
		provider,
		baseUrl,
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 200000,
		maxTokens: 64000,
	});
	const auth = (): ProviderAuth => ({
		apiKey: {
			name: "Test key",
			check: async ({ credential }) => (credential ? { type: "api_key" as const, source: "stored" } : undefined),
			resolve: async ({ credential }) =>
				credential ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
		},
	});
	const streamStub = () => {
		throw new Error("unused in model-registry tests");
	};
	const providers: Array<{ id: string; name: string; api: string; baseUrl: string; models: string[] }> = [
		{
			id: "anthropic",
			name: "Anthropic",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			models: ["claude-sonnet-4-5", "claude-opus-4-8", "claude-haiku-4-5"],
		},
		{
			id: "openrouter",
			name: "OpenRouter",
			api: "openai-completions",
			baseUrl: "https://openrouter.ai/api/v1",
			models: ["anthropic/claude-sonnet-4", "anthropic/claude-opus-4", "openai/gpt-4o-mini"],
		},
		{
			id: "openai",
			name: "OpenAI",
			api: "openai-completions",
			baseUrl: "https://api.openai.com/v1",
			models: ["gpt-4o-mini", "gpt-5-mini"],
		},
		{
			id: "google",
			name: "Google",
			api: "openai-completions",
			baseUrl: "https://generativelanguage.googleapis.com/v1",
			models: ["gemini-2.5-flash", "gemini-custom"],
		},
		{
			id: "zai",
			name: "Z.AI",
			api: "openai-completions",
			baseUrl: "https://api.z.ai/api/paas/v4",
			models: ["glm-5"],
		},
		{
			id: "github-copilot",
			name: "GitHub Copilot",
			api: "openai-responses",
			baseUrl: "https://api.githubcopilot.com/v1",
			models: ["gpt-5-mini"],
		},
	];
	for (const entry of providers) {
		runtime.registerNativeProvider({
			id: entry.id,
			name: entry.name,
			baseUrl: entry.baseUrl,
			auth: auth(),
			getModels: () => entry.models.map((id) => catalogModel(id, entry.api, entry.baseUrl, entry.id)),
			stream: streamStub,
			streamSimple: streamStub,
		});
	}
}

function wrap(runtime: ModelRuntime): ModelRegistry {
	const registry = new ModelRegistry(runtime);
	runtimes.set(registry, runtime);
	return registry;
}

/** Load optional models.json configuration without introducing file-backed catalog locks into unit tests. */
export async function createModelRegistry(credentials: CredentialStore, modelsPath?: string): Promise<ModelRegistry> {
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath,
		modelsStore: new InMemoryCodingAgentModelsStore(),
	});
	registerSharedFaux(runtime);
	return wrap(runtime);
}

export async function createInMemoryModelRegistry(credentials: CredentialStore): Promise<ModelRegistry> {
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
	registerSharedFaux(runtime);
	return wrap(runtime);
}

export function getModelRuntime(modelRegistry: ModelRegistry): ModelRuntime {
	const runtime = runtimes.get(modelRegistry);
	if (!runtime) throw new Error("ModelRegistry was not created by the test helper");
	return runtime;
}
