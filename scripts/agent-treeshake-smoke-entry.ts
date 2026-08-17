import { Agent } from "@xiaoliyo/pi-agent-core";
import { createModels, endpointProvider } from "@xiaoliyo/pi-ai";

const models = createModels();
models.setProvider(
	endpointProvider({
		id: "smoke",
		name: "Smoke",
		baseUrl: "https://example.test/v1",
		api: "openai-completions",
		models: [
			{
				id: "test",
				name: "Test",
				api: "openai-completions",
				provider: "smoke",
				baseUrl: "https://example.test/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16384,
			},
		],
	}),
);
const model = models.getModel("smoke", "test");
if (!model) throw new Error("Smoke-test model not found");

export const agent = new Agent({
	initialState: { model },
	streamFn: models.streamSimple.bind(models),
});
