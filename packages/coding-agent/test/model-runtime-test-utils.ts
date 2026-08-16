import { type Api, type CredentialStore, fauxProvider, type Model } from "@earendil-works/pi-ai";
import { AuthStorage } from "../src/core/auth-storage.ts";
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

/** Register the provider backing `testModel()` into a runtime so session auth checks pass. */
export function registerTestFaux(runtime: ModelRuntime): void {
	const faux = fauxProvider({
		api: "faux",
		provider: "anthropic",
		models: [{ id: "test-model" }],
	});
	runtime.registerNativeProvider(faux.provider);
}

/** A ModelRuntime with the shared faux provider registered, for testModel()-based sessions. */
export async function createTestModelRuntime(
	options: { credentials?: CredentialStore; modelsPath?: string | null } = {},
): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({
		credentials: options.credentials ?? AuthStorage.inMemory(),
		modelsPath: options.modelsPath ?? null,
		modelsStore: new InMemoryCodingAgentModelsStore(),
	});
	registerTestFaux(runtime);
	return runtime;
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
	return wrap(runtime);
}

export async function createInMemoryModelRegistry(credentials: CredentialStore): Promise<ModelRegistry> {
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
	return wrap(runtime);
}

export function getModelRuntime(modelRegistry: ModelRegistry): ModelRuntime {
	const runtime = runtimes.get(modelRegistry);
	if (!runtime) throw new Error("ModelRegistry was not created by the test helper");
	return runtime;
}
