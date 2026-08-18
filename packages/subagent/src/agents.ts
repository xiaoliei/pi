/**
 * Agent discovery, per-type runtime config (agents.json), and resolution.
 *
 * Layering (highest wins):
 *   1. tool-call parameters (task-level, then batch-level)
 *   2. agents.json entry for the agent type
 *   3. agent .md frontmatter (model, thinking)
 *   4. inherit dispatching session (current model / thinking level)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
// Cross-distribution imports: every pi distribution (upstream @earendil-works,
// fork @xiaoliyo) aliases @mariozechner/* to its own host modules, so these
// imports resolve identically under both. No runtime deps needed.
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter, withFileMutationQueue } from "@mariozechner/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: ThinkingLevel;
	systemPrompt: string;
	source: "builtin" | "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

/** Per-type override from <agentDir>/agents.json. null = inherit dispatching session. */
export interface AgentTypeEntry {
	model?: string | null;
	thinking?: string | null;
}

/**
 * Contents of <agentDir>/agents.json. `agents` maps agent type name to
 * model/thinking overrides; `trustedProjectAgentPaths` lists project agent
 * directories the user has marked trusted (skips the confirmation prompt).
 */
export interface AgentsConfigFile {
	agents: Record<string, AgentTypeEntry>;
	trustedProjectAgentPaths?: string[];
}

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

export function getAgentsConfigPath(): string {
	return path.join(getAgentDir(), "agents.json");
}

/** Load agents.json. Missing file or unparsable content yields {}. */
export function loadAgentsConfig(): AgentsConfigFile {
	const configPath = getAgentsConfigPath();
	let content: string;
	try {
		content = fs.readFileSync(configPath, "utf-8");
	} catch {
		return { agents: {} };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return { agents: {} };
	}
	if (typeof parsed !== "object" || parsed === null) return { agents: {} };
	const file = parsed as Record<string, unknown>;
	const result: AgentsConfigFile = { agents: {} };
	if (typeof file.agents === "object" && file.agents !== null) {
		for (const [name, value] of Object.entries(file.agents as Record<string, unknown>)) {
			if (typeof value !== "object" || value === null) continue;
			const entry = value as Record<string, unknown>;
			result.agents[name] = {
				model: typeof entry.model === "string" && entry.model.length > 0 ? entry.model : null,
				thinking: isThinkingLevel(entry.thinking) ? entry.thinking : null,
			};
		}
	}
	if (Array.isArray(file.trustedProjectAgentPaths)) {
		result.trustedProjectAgentPaths = file.trustedProjectAgentPaths.filter(
			(p): p is string => typeof p === "string" && p.length > 0,
		);
	}
	return result;
}

/** Persist agents.json (queued write, atomic-ish rename not needed for a single small file). */
export async function saveAgentsConfig(config: AgentsConfigFile): Promise<void> {
	const configPath = getAgentsConfigPath();
	await withFileMutationQueue(configPath, async () => {
		await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
		await fs.promises.writeFile(configPath, `${JSON.stringify(config, null, "\t")}\n`, "utf-8");
	});
}

/**
 * Raw agent frontmatter. Values are `unknown` because `parseFrontmatter` runs a
 * real YAML parser, so any scalar or collection can appear here.
 */
type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	thinking?: unknown;
};

/**
 * Normalize a frontmatter `tools` value to a list of tool names.
 *
 * Both spellings are valid YAML and both are in use:
 *
 *     tools: read, bash        # string
 *     tools: [read, bash]      # array
 *
 * so accept either. Anything else (a number, a map, a nested list) yields no
 * tools rather than throwing: this runs inside agent discovery, where a single
 * bad file must not take down every other agent in the same directory.
 */
function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function loadAgentsFromDir(dir: string, source: AgentConfig["source"]): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);

		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
			continue;
		}

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseToolList(frontmatter.tools),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			thinking: isThinkingLevel(frontmatter.thinking) ? frontmatter.thinking : undefined,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/** Directory of built-in agents shipped with this package. */
function getBuiltinAgentsDir(): string {
	// import.meta.url is .../packages/subagent/src/agents.ts -> .../packages/subagent/agents/
	return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agents");
}

export interface DiscoverAgentsOptions {
	cwd: string;
	scope: AgentScope;
}

export function discoverAgents(options: DiscoverAgentsOptions): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(options.cwd);

	const sources: AgentConfig[][] = [];
	if (options.scope !== "project") {
		sources.push(loadAgentsFromDir(getBuiltinAgentsDir(), "builtin"));
		sources.push(loadAgentsFromDir(userDir, "user"));
	}
	if (options.scope === "project" || options.scope === "both") {
		if (projectAgentsDir) sources.push(loadAgentsFromDir(projectAgentsDir, "project"));
	}

	const agentMap = new Map<string, AgentConfig>();
	for (const list of sources) {
		for (const agent of list) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

// -----------------------------------------------------------------------------
// Runtime model/thinking resolution
// -----------------------------------------------------------------------------

export interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface ResolvedAgentRuntime {
	model: string | undefined;
	thinking: ThinkingLevel | undefined;
}

function firstString(...values: Array<string | undefined | null>): string | undefined {
	for (const v of values) if (typeof v === "string" && v.length > 0) return v;
	return undefined;
}

/**
 * Resolve model/thinking for one agent invocation.
 *
 * Order: task param > batch param > agents.json > frontmatter > dispatch session.
 * Each value picks independently; dispatch session (inherit) wins only when
 * no higher layer set it.
 */
export function resolveAgentRuntime(
	agent: AgentConfig,
	typeConfig: { model?: string | null; thinking?: string | null },
	dispatch: DispatchDefaults,
	overrides?: { model?: string; thinking?: string },
): ResolvedAgentRuntime {
	const model = firstString(overrides?.model, typeConfig.model ?? undefined, agent.model, dispatch.model);
	const thinkingCandidates: Array<ThinkingLevel | undefined> = [
		isThinkingLevel(overrides?.thinking) ? overrides?.thinking : undefined,
		isThinkingLevel(typeConfig.thinking) ? typeConfig.thinking : undefined,
		agent.thinking,
		dispatch.thinkingLevel,
	];
	const thinking = thinkingCandidates.find(Boolean);
	return { model, thinking };
}
