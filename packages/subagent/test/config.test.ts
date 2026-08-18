/**
 * Tests for agent discovery config layering and runtime resolution.
 * Run: npm test (from packages/subagent)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AgentConfig,
	type AgentsConfigFile,
	isThinkingLevel,
	loadAgentsConfig,
	resolveAgentRuntime,
	saveAgentsConfig,
} from "../src/agents.ts";

let tempDirs: string[] = [];

function tempAgentDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-test-"));
	tempDirs.push(dir);
	process.env.PI_CODING_AGENT_DIR = dir;
	return dir;
}

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
	tempDirs = [];
});

describe("loadAgentsConfig", () => {
	it("returns empty config for missing file", () => {
		tempAgentDir();
		expect(loadAgentsConfig()).toEqual({ agents: {} });
	});

	it("tolerates unparsable content", () => {
		const dir = tempAgentDir();
		fs.writeFileSync(path.join(dir, "agents.json"), "{ not json");
		expect(loadAgentsConfig()).toEqual({ agents: {} });
	});

	it("round-trips through saveAgentsConfig and normalizes", async () => {
		tempAgentDir();
		const config: AgentsConfigFile = {
			agents: {
				explore: { model: "anthropic/claude-haiku-4-5", thinking: "low" },
				general: { model: null, thinking: null },
			},
		};
		await saveAgentsConfig(config);
		const loaded = loadAgentsConfig();
		expect(loaded.agents.explore?.model).toBe("anthropic/claude-haiku-4-5");
		expect(loaded.agents.explore?.thinking).toBe("low");
		expect(loaded.agents.general?.model).toBeNull();
		expect(loaded.agents.general?.thinking).toBeNull();
	});

	it("persists trustedProjectAgentPaths and drops garbage entries", async () => {
		const dir = tempAgentDir();
		fs.writeFileSync(
			path.join(dir, "agents.json"),
			JSON.stringify({
				agents: { explore: { model: null, thinking: null } },
				trustedProjectAgentPaths: ["/repo/.pi/agents", 42, ""],
			}),
		);
		const loaded = loadAgentsConfig();
		expect(loaded.trustedProjectAgentPaths).toEqual(["/repo/.pi/agents"]);
		expect(loaded.agents.explore?.model).toBeNull();
	});
});

describe("isThinkingLevel", () => {
	it("accepts valid levels and rejects garbage", () => {
		expect(isThinkingLevel("high")).toBe(true);
		expect(isThinkingLevel("max")).toBe(true);
		expect(isThinkingLevel("ultra")).toBe(false);
		expect(isThinkingLevel(42)).toBe(false);
	});
});

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "explore",
		description: "test agent",
		systemPrompt: "prompt",
		source: "builtin",
		filePath: "/tmp/explore.md",
		...overrides,
	};
}

const dispatch = { model: "anthropic/claude-sonnet-4-5", thinkingLevel: "medium" as const };

describe("resolveAgentRuntime", () => {
	it("all layers null -> inherit dispatch", () => {
		const runtime = resolveAgentRuntime(makeAgent(), { model: null, thinking: null }, dispatch);
		expect(runtime.model).toBe("anthropic/claude-sonnet-4-5");
		expect(runtime.thinking).toBe("medium");
	});

	it("agents.json wins over frontmatter", () => {
		const agent = makeAgent({ model: "frontmatter/model", thinking: "low" });
		const runtime = resolveAgentRuntime(agent, { model: "config/model", thinking: "high" }, dispatch);
		expect(runtime.model).toBe("config/model");
		expect(runtime.thinking).toBe("high");
	});

	it("frontmatter wins over dispatch session", () => {
		const agent = makeAgent({ model: "frontmatter/model", thinking: "low" });
		const runtime = resolveAgentRuntime(agent, { model: null, thinking: null }, dispatch);
		expect(runtime.model).toBe("frontmatter/model");
		expect(runtime.thinking).toBe("low");
	});

	it("task override beats everything", () => {
		const agent = makeAgent({ model: "frontmatter/model", thinking: "low" });
		const runtime = resolveAgentRuntime(agent, { model: "config/model", thinking: "high" }, dispatch, {
			model: "task/model",
			thinking: "max",
		});
		expect(runtime.model).toBe("task/model");
		expect(runtime.thinking).toBe("max");
	});

	it("model override alone does not pin thinking", () => {
		const runtime = resolveAgentRuntime(makeAgent(), { model: null, thinking: null }, dispatch, {
			model: "task/model",
		});
		expect(runtime.model).toBe("task/model");
		expect(runtime.thinking).toBe("medium");
	});
});
