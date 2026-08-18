/**
 * Subagent extension: delegate tasks to specialized agents with isolated
 * context windows. See docs/plans/2026-08-17-subagent-extension-design.md.
 *
 * Derived from the official examples/extensions/subagent with additions:
 * - per-type runtime config (<agentDir>/agents.json) + /agents TUI command
 * - model/thinking overrides at call time (task-level and batch-level)
 * - built-in agent types shipped in the package agents/ dir
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@mariozechner/pi-agent-core";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme, getSelectListTheme } from "@mariozechner/pi-coding-agent";
import { type SelectItem, SelectList } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import {
	type AgentConfig,
	type AgentScope,
	type AgentsConfigFile,
	type AgentTypeEntry,
	discoverAgents,
	getAgentsConfigPath,
	loadAgentsConfig,
	resolveAgentRuntime,
	saveAgentsConfig,
	THINKING_LEVELS,
} from "./agents.ts";
import { ModelSearchSelector } from "./model-selector.ts";
import {
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	renderSubagentCall,
	renderSubagentResult,
	type SingleResult,
	type SubagentDetails,
	type UsageStats,
} from "./render.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const TRUST_OPTION = "Trust these agents (no future prompts)";

const THINKING_DESCRIPTIONS: Record<(typeof THINKING_LEVELS)[number], string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Extra-high reasoning (~32k tokens)",
	max: "Maximum reasoning",
};

const emptyUsage = (): UsageStats => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 0,
});

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;
	// Byte-accurate slice; a mid-character cut decodes to one replacement char, harmless here.
	const truncated = Buffer.from(output).subarray(0, PER_TASK_OUTPUT_CAP).toString("utf8");
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers: Promise<void>[] = [];
	for (let i = 0; i < limit; i++) {
		workers.push(
			(async () => {
				while (true) {
					const current = nextIndex++;
					if (current >= items.length) return;
					results[current] = await fn(items[current], current);
				}
			})(),
		);
	}
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type ToolResultContent = {
	content: Array<{ type: "text"; text: string }>;
	details: SubagentDetails;
	isError?: boolean;
};

type OnUpdateCallback = (partial: ToolResultContent) => void;

export interface RunAgentOptions {
	defaultCwd: string;
	agents: AgentConfig[];
	configFile: AgentsConfigFile;
	dispatchModel?: string;
	dispatchThinkingLevel?: ThinkingLevel;
	batchModel?: string;
	batchThinking?: string;
	signal?: AbortSignal;
	onUpdate?: OnUpdateCallback;
}

interface AgentCall {
	agent: string;
	task: string;
	cwd?: string;
	model?: string;
	thinking?: string;
	step?: number;
}

async function runSingleAgent(
	options: RunAgentOptions,
	call: AgentCall,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	onUpdateOverride?: OnUpdateCallback,
): Promise<SingleResult> {
	const { agent: agentName, task, cwd, step } = call;
	const agent = options.agents.find((a) => a.name === agentName);

	if (!agent) {
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents:\n${formatAgentRoster(options.agents)}`,
			usage: emptyUsage(),
			step,
		};
	}

	// Layered resolution: task > batch > agents.json > frontmatter > dispatch session
	const runtime = resolveAgentRuntime(
		agent,
		options.configFile.agents[agent.name] ?? { model: null, thinking: null },
		{ model: options.dispatchModel, thinkingLevel: options.dispatchThinkingLevel },
		{ model: call.model ?? options.batchModel, thinking: call.thinking ?? options.batchThinking },
	);
	const model = runtime.model;
	const thinking = runtime.thinking;

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (model) args.push("--model", model);
	// Only pass --thinking when the dispatch session explicitly configured it;
	// sub-process falls back to its own defaults otherwise.
	if (thinking) args.push("--thinking", thinking);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model,
		thinking,
		step,
	};

	const update = onUpdateOverride ?? options.onUpdate;
	const emitUpdate = () => {
		update?.({
			content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
			details: makeDetails([currentResult]),
		});
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const accumulateMessage = (msg: SingleResult["messages"][number], result: SingleResult) => {
			result.messages.push(msg);
			if (msg.role !== "assistant") return;
			result.usage.turns++;
			const usage = msg.usage;
			if (usage) {
				result.usage.input += usage.input || 0;
				result.usage.output += usage.output || 0;
				result.usage.cacheRead += usage.cacheRead || 0;
				result.usage.cacheWrite += usage.cacheWrite || 0;
				result.usage.cost += usage.cost?.total || 0;
				result.usage.contextTokens = usage.totalTokens || 0;
			}
			if (!result.model && msg.model) result.model = msg.model;
			if (msg.stopReason) result.stopReason = msg.stopReason;
			if (msg.errorMessage) result.errorMessage = msg.errorMessage;
		};

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? options.defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: unknown;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				const typed = event as { type?: string; message?: SingleResult["messages"][number] };

				if (typed.type === "message_end" && typed.message) {
					accumulateMessage(typed.message, currentResult);
					emitUpdate();
				}

				if (typed.type === "tool_result_end" && typed.message) {
					currentResult.messages.push(typed.message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (options.signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (options.signal.aborted) killProc();
				else options.signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptDir)
			try {
				fs.rmSync(tmpPromptDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	model: Type.Optional(
		Type.String({ description: "Model override (provider/id), overrides agents.json and frontmatter" }),
	),
	thinking: Type.Optional(
		Type.String({ description: "Thinking level override (off|minimal|low|medium|high|xhigh|max)" }),
	),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description:
		'Which agent directories to use. Default: "user" (includes built-in). Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(
		Type.String({ description: 'Name of the agent to invoke, or "list" (without task) to list available agents' }),
	),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(
		Type.Array(TaskItem, { description: "Array of {agent, task} for sequential execution ({previous} placeholder)" }),
	),
	agentScope: Type.Optional(AgentScopeSchema),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	model: Type.Optional(Type.String({ description: "Model override (provider/id) for all tasks (task-level wins)" })),
	thinking: Type.Optional(Type.String({ description: "Thinking level override for all tasks (task-level wins)" })),
});

function formatAgentRoster(agents: AgentConfig[]): string {
	return agents.map((a) => `- ${a.name} (${a.source}): ${a.description}`).join("\n") || "(none)";
}

function formatTypeConfigLine(name: string, config: AgentsConfigFile): string {
	const entry = config.agents[name];
	const model = entry?.model ?? null;
	const thinking = entry?.thinking ?? null;
	if (!model && !thinking) return `${name}: inherit dispatch session`;
	return `${name}: model=${model ?? "inherit"}, thinking=${thinking ?? "inherit"}`;
}

async function runChain(
	runOptions: RunAgentOptions,
	chain: AgentCall[],
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<ToolResultContent> {
	const results: SingleResult[] = [];
	let previousOutput = "";

	for (let i = 0; i < chain.length; i++) {
		const step = chain[i];
		const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

		// Combine completed results with current streaming result
		const chainUpdate: OnUpdateCallback | undefined = runOptions.onUpdate
			? (partial) => {
					const currentResult = partial.details.results[0];
					if (currentResult) {
						runOptions.onUpdate?.({
							content: partial.content,
							details: makeDetails([...results, currentResult]),
						});
					}
				}
			: undefined;

		const result = await runSingleAgent(
			runOptions,
			{ ...step, task: taskWithContext, step: i + 1 },
			makeDetails,
			chainUpdate,
		);
		results.push(result);

		if (isFailedResult(result)) {
			return {
				content: [
					{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${getResultOutput(result)}` },
				],
				details: makeDetails(results),
				isError: true,
			};
		}
		previousOutput = getFinalOutput(result.messages);
	}
	return {
		content: [{ type: "text", text: getFinalOutput(results.at(-1)?.messages ?? []) || "(no output)" }],
		details: makeDetails(results),
	};
}

async function runParallel(
	runOptions: RunAgentOptions,
	tasks: AgentCall[],
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<ToolResultContent> {
	const allResults: SingleResult[] = tasks.map((t) => ({
		agent: t.agent,
		agentSource: "unknown",
		task: t.task,
		exitCode: -1, // -1 = still running
		messages: [],
		stderr: "",
		usage: emptyUsage(),
	}));

	const emitParallelUpdate = () => {
		const onUpdate = runOptions.onUpdate;
		if (!onUpdate) return;
		const running = allResults.filter((r) => r.exitCode === -1).length;
		const done = allResults.filter((r) => r.exitCode !== -1).length;
		onUpdate({
			content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
			details: makeDetails([...allResults]),
		});
	};

	const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t, index) => {
		const result = await runSingleAgent(runOptions, t, makeDetails, (partial) => {
			// Merge the streaming partial into the shared list, then re-emit as a
			// parallel-shaped update so the TUI never flips to a single-task view.
			const current = partial.details.results[0];
			if (current) {
				allResults[index] = current;
				emitParallelUpdate();
			}
		});
		allResults[index] = result;
		emitParallelUpdate();
		return result;
	});

	const successCount = results.filter((r) => !isFailedResult(r)).length;
	const summaries = results.map((r) => {
		const output = truncateParallelOutput(getResultOutput(r));
		let status = "completed";
		if (isFailedResult(r)) {
			status = `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`;
		}
		return `### [${r.agent}] ${status}\n\n${output}`;
	});
	return {
		content: [
			{
				type: "text",
				text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
			},
		],
		details: makeDetails(results),
	};
}

export default function subagentExtension(pi: ExtensionAPI) {
	// /agents: view and edit per-type defaults (agents.json)
	pi.registerCommand("agents", {
		description: "Configure default model/thinking per agent type (agents.json)",
		handler: async (_args, ctx) => {
			const configPath = getAgentsConfigPath();
			const config = loadAgentsConfig();
			const discovery = discoverAgents({ cwd: ctx.cwd, scope: "both" });

			if (discovery.agents.length === 0) {
				ctx.ui.notify(`No agents found. Config: ${configPath}`, "warning");
				return;
			}

			if (!ctx.hasUI) {
				const lines = [`Config file: ${configPath}`, ""];
				for (const a of discovery.agents) lines.push(formatTypeConfigLine(a.name, config));
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			const choice = await ctx.ui.select(
				"Agent type:",
				discovery.agents.map((a) => `${a.name} (${a.source})`),
			);
			if (choice === undefined) return;
			const match = choice.match(/^(\S+)/);
			if (!match) return;
			const agentName = match[1];
			if (!discovery.agents.some((a) => a.name === agentName)) return;

			// Model selection from the registry (same source as /models), inherit first.
			// Rows mirror /models: "id [provider]", provider badge muted, fuzzy search.
			const availableModels = ctx.modelRegistry ? ctx.modelRegistry.getAvailable() : [];
			if (availableModels.length === 0) {
				ctx.ui.notify("No models available in the registry", "error");
				return;
			}
			const currentEntry = config.agents[agentName] ?? { model: null, thinking: null };
			// ui.custom returns undefined in RPC mode (factory never runs);
			// aborting setup here mirrors canceling the dialog.
			const modelChoice = await ctx.ui.custom<string | undefined>(
				(tui, uiTheme, _kb, done) =>
					new ModelSearchSelector(
						tui,
						uiTheme,
						`Model for "${agentName}":`,
						availableModels,
						done,
						currentEntry.model ?? null,
					),
			);
			if (modelChoice === undefined) return;
			const trimmedModel = modelChoice === "inherit" ? "" : modelChoice;

			// Thinking entry: SelectList with the current level preselected (✓ at current row).
			const currentThinking = currentEntry.thinking ?? "inherit";
			const thinkingItems: SelectItem[] = [
				{ value: "inherit", label: "inherit", description: "Use the dispatching session's level" },
				...THINKING_LEVELS.map((level) => ({
					value: level,
					label: level,
					description: THINKING_DESCRIPTIONS[level],
				})),
			];
			const thinkingChoice = await ctx.ui.custom<string | undefined>((_tui, uiTheme, _kb, done) => {
				const items: SelectItem[] = thinkingItems.map((item) => ({
					...item,
					label: item.value === currentThinking ? `${item.label} ${uiTheme.fg("success", "✓")}` : item.label,
				}));
				const selectList = new SelectList(items, items.length, getSelectListTheme());
				const currentIndex = items.findIndex((item) => item.value === currentThinking);
				if (currentIndex !== -1) selectList.setSelectedIndex(currentIndex);
				selectList.onSelect = (item) => done(item.value);
				selectList.onCancel = () => done(undefined);
				return selectList;
			});
			if (thinkingChoice === undefined) return;

			const entry = config.agents[agentName] ?? { model: null, thinking: null };
			entry.model = trimmedModel.length > 0 ? trimmedModel : null;
			entry.thinking = thinkingChoice === "inherit" ? null : (thinkingChoice as AgentTypeEntry["thinking"]);
			config.agents[agentName] = entry;

			await saveAgentsConfig(config);
			ctx.ui.notify(`Saved ${configPath}`, "info");
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			'Call agent="list" first to discover available agents and their descriptions.',
			"Per-type model/thinking defaults come from agents.json (/agents command); model/thinking params override per call.",
			'Default agent scope is "user" (built-in + user agents). Project-local agents need agentScope "both" or "project".',
		].join(" "),
		promptSnippet: "Delegate tasks to specialized subagents (single, parallel, or chain)",
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents({ cwd: ctx.cwd, scope: agentScope });
			const agents = discovery.agents;
			const configFile = loadAgentsConfig();

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					results,
				});

			const runOptions: RunAgentOptions = {
				defaultCwd: ctx.cwd,
				agents,
				configFile,
				dispatchModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				dispatchThinkingLevel: ctx.thinkingLevel,
				batchModel: params.model,
				batchThinking: params.thinking,
				signal,
				onUpdate,
			};

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);

			// Discovery mode: agent="list" without task/chain/tasks returns the roster.
			if (params.agent === "list" && !hasChain && !hasTasks && !params.task) {
				return {
					content: [
						{ type: "text", text: `Available agents (${agentScope} scope):\n${formatAgentRoster(agents)}` },
					],
					details: makeDetails("single")([]),
				};
			}

			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			if (modeCount !== 1) {
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.
Available agents (${agentScope} scope, use agent="list" to re-query):
${formatAgentRoster(agents)}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			// Trust gate for project-local agents: repo-controlled system prompts.
			// Not a tool parameter, so the model cannot bypass it. Per-path trust is
			// remembered in agents.json (trustedProjectAgentPaths).
			const requestedAgentNames = new Set<string>();
			if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
			if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
			if (params.agent) requestedAgentNames.add(params.agent);

			const projectAgentsRequested = Array.from(requestedAgentNames)
				.map((name) => agents.find((a) => a.name === name))
				.filter((a): a is AgentConfig => a?.source === "project");

			if (projectAgentsRequested.length > 0 && ctx.hasUI) {
				const trustedPaths = configFile.trustedProjectAgentPaths ?? [];
				const dir = discovery.projectAgentsDir;
				if (dir === null || !trustedPaths.includes(dir)) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const choice = await ctx.ui.select(
						`Run project-local agents?\nAgents: ${names}\nSource: ${dir ?? "(unknown)"}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
						["Yes, run once", TRUST_OPTION, "No"],
					);
					if (choice !== "Yes, run once" && choice !== TRUST_OPTION) {
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
					}
					if (choice === TRUST_OPTION && dir !== null) {
						await saveAgentsConfig({
							...configFile,
							trustedProjectAgentPaths: [...trustedPaths, dir],
						});
					}
				}
			}

			if (params.chain && params.chain.length > 0) return runChain(runOptions, params.chain, makeDetails("chain"));
			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};
				return runParallel(runOptions, params.tasks, makeDetails("parallel"));
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					runOptions,
					{
						agent: params.agent,
						task: params.task,
						cwd: params.cwd,
						// batch-level overrides double as single-mode overrides
						model: params.model,
						thinking: params.thinking,
					},
					makeDetails("single"),
				);
				if (isFailedResult(result)) {
					return {
						content: [
							{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${getResultOutput(result)}` },
						],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}
			// Unreachable when modeCount === 1, but TS can't narrow that; keep a
			// terminating return so execute has an AgentToolResult on every path.
			return {
				content: [{ type: "text", text: "Invalid parameters: provide agent+task, tasks, or chain." }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			return renderSubagentCall(args as Record<string, unknown>, theme);
		},

		renderResult(result, options, theme, _context) {
			return renderSubagentResult(
				result as AgentToolResult<SubagentDetails>,
				{ expanded: options.expanded },
				theme,
				getMarkdownTheme,
			);
		},
	});
}
