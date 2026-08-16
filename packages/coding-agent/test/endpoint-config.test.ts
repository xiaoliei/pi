import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	deleteEndpointEntry,
	deriveEndpointId,
	mergeDiscoveredModels,
	modelDefinitionsFromDiscovery,
	preferredDiscoveryApi,
	uniqueEndpointId,
	updateEndpointEntry,
	updateEndpointModels,
	writeEndpointEntry,
} from "../src/core/endpoint-config.ts";
import { ModelConfig } from "../src/core/model-config.ts";

function tempModelsJson(): { dir: string; path: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "pi-endpoint-config-"));
	const path = join(dir, "models.json");
	return {
		dir,
		path,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("endpoint-config", () => {
	it("derives endpoint ids from baseUrl hosts and uniquifies collisions", () => {
		expect(deriveEndpointId("https://relay.example.com/v1")).toBe("relay-example-com");
		expect(uniqueEndpointId(new Set(["relay-example-com"]), "https://relay.example.com/v1")).toBe(
			"relay-example-com-2",
		);
	});

	it("writes and reads endpoint entries without disturbing comments", async () => {
		const { path, cleanup } = tempModelsJson();
		try {
			writeFileSync(path, '{\n\t// keep me\n\t"providers": {}\n}\n', "utf-8");
			await writeEndpointEntry(
				path,
				{
					id: "my-relay",
					name: "My Relay",
					baseUrl: "https://relay.example.com/v1",
					api: "openai-completions",
					apiKey: "sk-test",
				},
				[{ id: "gpt-test", enabled: true, api: "openai-completions", reasoning: false }],
			);

			const config = await ModelConfig.load(path);
			expect(config.getError()).toBeUndefined();
			const provider = config.getProvider("my-relay");
			expect(provider?.baseUrl).toBe("https://relay.example.com/v1");
			expect(provider?.apiKey).toBe("sk-test");
			expect(provider?.models?.[0]?.id).toBe("gpt-test");

			const content = readFileSync(path, "utf-8");
			expect(content).toContain("// keep me");
		} finally {
			cleanup();
		}
	});

	it("updates and deletes endpoint entries", async () => {
		const { path, cleanup } = tempModelsJson();
		try {
			await writeEndpointEntry(
				path,
				{
					id: "relay",
					name: "Relay",
					baseUrl: "https://relay.example.com/v1",
					api: "openai-completions",
					apiKey: "one",
				},
				[{ id: "m1", enabled: true, api: "openai-completions" }],
			);

			await updateEndpointEntry(path, "relay", { apiKey: "two", headers: { "X-Custom": "yes" } });
			let provider = (await ModelConfig.load(path)).getProvider("relay");
			expect(provider?.apiKey).toBe("two");
			expect(provider?.headers).toEqual({ "X-Custom": "yes" });

			await updateEndpointModels(path, "relay", [
				{ id: "m1", enabled: false, api: "openai-completions" },
				{ id: "m2", enabled: true, api: "openai-completions" },
			]);
			provider = (await ModelConfig.load(path)).getProvider("relay");
			expect(provider?.models?.map((model) => model.id)).toEqual(["m1", "m2"]);

			await deleteEndpointEntry(path, "relay");
			expect((await ModelConfig.load(path)).getProvider("relay")).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	it("refuses to overwrite an unparsable models.json", async () => {
		const { path, cleanup } = tempModelsJson();
		try {
			writeFileSync(path, "{ not json", "utf-8");
			await expect(
				writeEndpointEntry(path, {
					id: "relay",
					name: "Relay",
					baseUrl: "https://relay.example.com/v1",
					api: "openai-completions",
				}),
			).rejects.toThrow(/Not writing models.json/);
		} finally {
			cleanup();
		}
	});

	it("maps discovery metadata and merges without clobbering user edits", () => {
		expect(preferredDiscoveryApi("openai-completions", "gpt-5-mini")).toBe("openai-responses");
		expect(preferredDiscoveryApi("anthropic-messages", "claude-haiku-4-5")).toBe("anthropic-messages");

		const definitions = modelDefinitionsFromDiscovery(
			[{ id: "gpt-5", name: "GPT-5" }, { id: "unknown-model" }],
			"openai-completions",
		);
		expect(definitions[0]).toMatchObject({ id: "gpt-5", name: "GPT-5", enabled: true, api: "openai-responses" });
		expect(definitions[1]).toMatchObject({ id: "unknown-model", contextWindow: 128000, maxTokens: 16384 });

		const existing = [{ id: "gpt-5", enabled: false, api: "openai-responses" }];
		const merged = mergeDiscoveredModels(existing, definitions);
		expect(merged.map((model) => model.id)).toEqual(["gpt-5", "unknown-model"]);
		expect(merged[0]).toEqual(existing[0]);
	});
});
