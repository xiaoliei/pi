import type { Model, Provider } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { CredentialSynchronizationError, ModelRuntime } from "../src/core/model-runtime.ts";

function model(provider: string): Model<"openai-completions"> {
	return {
		id: "dynamic",
		name: "Dynamic",
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function provider(
	id: string,
	options: {
		refreshModels?: Provider["refreshModels"];
	} = {},
): Provider<"openai-completions"> {
	const providerModel = model(id);
	return {
		id,
		name: id,
		auth: {
			apiKey: {
				name: "API key",
				check: async ({ credential }) => (credential ? { type: "api_key", source: "stored" } : undefined),
				resolve: async ({ credential }) =>
					credential ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
			},
		},
		getModels: () => [providerModel],
		refreshModels: options.refreshModels,
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	};
}

async function runtimeWithProvider(
	registered: Provider,
	credentials: AuthStorage = AuthStorage.inMemory(),
): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
	runtime.registerNativeProvider(registered);
	await runtime.refresh({ allowNetwork: false, providers: [registered.id] });
	return runtime;
}

describe("ModelRuntime credential synchronization", () => {
	it("publishes locally consistent availability before setRuntimeApiKey and removeRuntimeApiKey resolve", async () => {
		const credentials = AuthStorage.inMemory();
		const runtime = await runtimeWithProvider(provider("dynamic"), credentials);

		await runtime.setRuntimeApiKey("dynamic", "dynamic-key");
		expect(runtime.hasConfiguredAuth("dynamic")).toBe(true);
		expect(runtime.getAvailableSnapshot().map((entry) => entry.id)).toContain("dynamic");
		expect(runtime.getProviderAuthStatus("dynamic")).toEqual({ configured: true, source: "runtime" });
		expect((await runtime.getAuth("dynamic"))?.auth.apiKey).toBe("dynamic-key");

		await runtime.removeRuntimeApiKey("dynamic");
		expect(runtime.hasConfiguredAuth("dynamic")).toBe(false);
		expect(runtime.getAvailableSnapshot().some((entry) => entry.provider === "dynamic")).toBe(false);
		expect(runtime.getProviderAuthStatus("dynamic").configured).toBe(false);
	});

	it("reports cancellation that occurs during provider-scoped availability", async () => {
		let blockAvailability = false;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const registered = provider("cancelled-availability");
		if (registered.auth.apiKey) {
			registered.auth.apiKey.check = async ({ credential }) => {
				if (blockAvailability) {
					markStarted?.();
					await new Promise<void>(() => {});
				}
				return credential ? { type: "api_key", source: "stored" } : undefined;
			};
		}
		const runtime = await runtimeWithProvider(registered);
		await runtime.setRuntimeApiKey(registered.id, "key");
		blockAvailability = true;
		const controller = new AbortController();
		const refresh = runtime.refresh({
			allowNetwork: false,
			providers: [registered.id],
			signal: controller.signal,
		});
		await started;
		controller.abort();

		await expect(refresh).resolves.toMatchObject({ aborted: true });
	});

	it("does not run network refresh inside the credential operation chain", async () => {
		const networkRefresh = vi.fn(async () => new Promise<void>(() => {}));
		const runtime = await runtimeWithProvider(
			provider("local-only", {
				refreshModels: async (context) => {
					if (context.allowNetwork) await networkRefresh();
				},
			}),
		);

		await runtime.setRuntimeApiKey("local-only", "key");
		expect(networkRefresh).not.toHaveBeenCalled();
		expect(runtime.hasConfiguredAuth("local-only")).toBe(true);
	});

	it("reports a typed error when cancellation interrupts post-commit synchronization", async () => {
		let blockCacheRefresh = false;
		let markCacheRefreshStarted: (() => void) | undefined;
		const cacheRefreshStarted = new Promise<void>((resolve) => {
			markCacheRefreshStarted = resolve;
		});
		const credentials = AuthStorage.inMemory();
		const runtime = await runtimeWithProvider(
			provider("cancelled-sync", {
				refreshModels: async (context) => {
					if (!context.allowNetwork && blockCacheRefresh) {
						markCacheRefreshStarted?.();
						await new Promise<void>(() => {});
					}
				},
			}),
			credentials,
		);
		blockCacheRefresh = true;
		const controller = new AbortController();
		const remove = runtime.removeRuntimeApiKey("cancelled-sync", { signal: controller.signal });
		await cacheRefreshStarted;
		controller.abort();

		await expect(remove).rejects.toMatchObject({
			name: "CredentialSynchronizationError",
			providerId: "cancelled-sync",
			operation: "removeRuntimeApiKey",
		});
	});

	it("reports committed runtime keys when local synchronization fails", async () => {
		let failCacheRefresh = false;
		const credentials = AuthStorage.inMemory();
		const runtime = await runtimeWithProvider(
			provider("broken-sync", {
				refreshModels: async (context) => {
					if (!context.allowNetwork && failCacheRefresh) throw new Error("cache restore failed");
				},
			}),
			credentials,
		);
		failCacheRefresh = true;

		const set = runtime.setRuntimeApiKey("broken-sync", "broken-sync-key");
		await expect(set).rejects.toMatchObject({
			name: "CredentialSynchronizationError",
			providerId: "broken-sync",
			operation: "setRuntimeApiKey",
			credential: { type: "api_key", key: "broken-sync-key" },
		});
		await expect(set).rejects.toBeInstanceOf(CredentialSynchronizationError);
		expect(runtime.getProviderAuthStatus("broken-sync").source).toBe("runtime");
	});
});
