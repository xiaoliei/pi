import type { Model, Provider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import type { Harness } from "../harness.ts";

const dynamicModel: Model<"openai-completions"> = {
	id: "dynamic",
	name: "Dynamic",
	api: "openai-completions",
	provider: "stalled-login",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

describe("issues #7027 and #7113 credential refresh hang", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		vi.useRealTimers();
		harness?.cleanup();
		harness = undefined;
		vi.restoreAllMocks();
	});

	it("does not hold login behind an older stalled network catalog refresh", async () => {
		let markNetworkStarted: (() => void) | undefined;
		const networkStarted = new Promise<void>((resolve) => {
			markNetworkStarted = resolve;
		});
		const provider: Provider<"openai-completions"> = {
			id: "stalled-login",
			name: "Stalled Login",
			auth: {
				apiKey: {
					name: "API key",
					check: async ({ credential }) =>
						credential?.key ? { type: "api_key", source: "stored key" } : undefined,
					resolve: async ({ credential }) => ({
						auth: { apiKey: credential?.key ?? "ambient-key" },
						source: credential?.key ? "stored key" : "ambient key",
					}),
				},
			},
			getModels: () => [dynamicModel],
			refreshModels: async ({ allowNetwork }) => {
				if (!allowNetwork) return;
				markNetworkStarted?.();
				await new Promise<void>(() => {});
			},
			stream: () => {
				throw new Error("unused");
			},
			streamSimple: () => {
				throw new Error("unused");
			},
		};
		const credentials = AuthStorage.inMemory();
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
		runtime.registerNativeProvider(provider);
		await runtime.refresh({ allowNetwork: false, providers: [provider.id] });

		const stalledRefresh = runtime.refresh({ allowNetwork: true, providers: [provider.id] });
		await networkStarted;
		await runtime.setRuntimeApiKey(provider.id, "secret");

		expect(runtime.getAvailableSnapshot().map((model) => model.id)).toContain(dynamicModel.id);
		expect(runtime.getProviderAuthStatus(provider.id)).toEqual({ configured: true, source: "runtime" });
		await expect(stalledRefresh).resolves.toMatchObject({ aborted: false });
	});
});
