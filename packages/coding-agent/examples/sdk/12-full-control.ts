/**
 * Full Control
 *
 * Replace everything - no discovery, explicit configuration.
 */

import {
	createAgentSession,
	createExtensionRuntime,
	ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create({
	authPath: "/tmp/my-agent/auth.json",
	modelsPath: "/tmp/my-agent/models.json",
});

// Models come from /connect (or hand-edited models.json). Resolve one:
const model = modelRuntime.getModel("my-anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Model not found. Add an endpoint with /connect (or write models.json).");

// In-memory settings with overrides
const settingsManager = SettingsManager.inMemory({
	compaction: { enabled: false },
	retry: { enabled: true, maxRetries: 2 },
});

const cwd = process.cwd();

const resourceLoader: ResourceLoader = {
	getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
	getSkills: () => ({ skills: [], diagnostics: [] }),
	getPrompts: () => ({ prompts: [], diagnostics: [] }),
	getThemes: () => ({ themes: [], diagnostics: [] }),
	getAgentsFiles: () => ({ agentsFiles: [] }),
	getSystemPrompt: () => `You are a minimal assistant.
Available: read, bash. Be concise.`,
	getSystemPromptSource: () => undefined,
	getAppendSystemPrompt: () => [],
	getAppendSystemPromptSources: () => [],
	extendResources: () => {},
	reload: async () => {},
};

const { session } = await createAgentSession({
	cwd,
	agentDir: "/tmp/my-agent",
	model,
	thinkingLevel: "off",
	modelRuntime,
	resourceLoader,
	tools: ["read", "bash"],
	sessionManager: SessionManager.inMemory(cwd),
	settingsManager,
});

try {
	session.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	await session.prompt("List files in the current directory.");
	console.log();
} finally {
	session.dispose();
}
