#!/usr/bin/env node

// Regenerates packages/ai/src/known-models.ts from upstream model data.
//
// Two sources are supported:
//   1. The model data shipped by the upstream pi-ai npm package
//      (dist/providers/data/*.json), produced by the upstream
//      generate-models pipeline.
//   2. The models.dev API directly (https://models.dev/api.json), the same
//      source the upstream pipeline consumed.
//
// Usage:
//   # offline: from the upstream npm tarball
//   npm pack @xiaoliyo/pi-ai@<version>
//   tar -xzf pi-ai-<version>.tgz
//   node packages/ai/scripts/export-known-models.mjs \
//     --data <path>/package/dist/providers/data \
//     [--out packages/ai/src/known-models.ts] [--source <label>]
//
//   # live: fetch models.dev
//   node packages/ai/scripts/export-known-models.mjs --models-dev \
//     [--out packages/ai/src/known-models.ts] [--source <label>]
//   # live via a mirror or local copy (for offline networks):
//   node packages/ai/scripts/export-known-models.mjs --models-dev \
//     --models-dev-url https://mirror.example/models.dev/api.json

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_OUT = resolve(__dirname, "../src/known-models.ts");
const MODELS_DEV_URL = "https://models.dev/api.json";

const DEFAULT_METADATA = {
	contextWindow: 128000,
	maxTokens: 16384,
	reasoning: false,
	input: ["text"],
};

function parseArgs(args) {
	const options = { input: undefined, out: DEFAULT_OUT, sourceLabel: undefined, modelsDevUrl: MODELS_DEV_URL };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--data") {
			options.input = { kind: "data-dir", dir: resolve(args[++index]) };
			continue;
		}
		if (arg === "--models-dev") {
			options.input = { kind: "models-dev" };
			continue;
		}
		if (arg === "--models-dev-url") {
			options.modelsDevUrl = args[++index];
			continue;
		}
		if (arg === "--out") {
			options.out = resolve(args[++index]);
			continue;
		}
		if (arg === "--source") {
			options.sourceLabel = args[++index];
			continue;
		}
		if (arg === "--help") {
			console.log(
				"Usage: node packages/ai/scripts/export-known-models.mjs (--data <dir> | --models-dev) [--out <file>] [--source <label>]",
			);
			process.exit(0);
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	if (!options.input) throw new Error("--data <dir> or --models-dev is required");
	if (options.input.kind !== "models-dev" && options.modelsDevUrl !== MODELS_DEV_URL) {
		throw new Error("--models-dev-url requires --models-dev");
	}
	return options;
}

function metadataKey(metadata) {
	return JSON.stringify([
		metadata.contextWindow,
		metadata.maxTokens,
		metadata.reasoning,
		[...metadata.input].sort(),
	]);
}

/** Pick the metadata variant with the largest context window and max tokens. */
function pickWinner(variants) {
	return [...variants].sort((a, b) => {
		if (a.metadata.contextWindow !== b.metadata.contextWindow) {
			return b.metadata.contextWindow - a.metadata.contextWindow;
		}
		if (a.metadata.maxTokens !== b.metadata.maxTokens) {
			return b.metadata.maxTokens - a.metadata.maxTokens;
		}
		return 0;
	})[0];
}

function normalizeInput(input) {
	const values = Array.isArray(input) ? input.filter((value) => value === "text" || value === "image") : [];
	return values.length > 0 ? values : DEFAULT_METADATA.input;
}

// Provider/region qualifiers that prefix a model id as "<qualifier>.<model>"
// in gateway catalogs (e.g. "openai.gpt-5.4", "us.anthropic.claude-sonnet-4-6").
// Version dotted families such as "gpt-4.1" or "claude-opus-4.5" are not
// qualifiers and must survive normalization.
const MODEL_ID_QUALIFIERS = [
	// region codes
	"us",
	"eu",
	"jp",
	"au",
	"uk",
	"global",
	"cn",
	"in",
	"ap",
	"sa",
	"ca",
	"kr",
	"sg",
	// provider/vendor qualifiers observed in upstream model data
	"ai21",
	"amazon",
	"amazon-bedrock",
	"ant-ling",
	"anthropic",
	"azure-openai-responses",
	"cloudflare-ai-gateway",
	"cloudflare-workers-ai",
	"deepseek",
	"github-copilot",
	"google",
	"google-vertex",
	"kimi-coding",
	"minimax",
	"minimax-cn",
	"mistral",
	"meta",
	"moonshot",
	"moonshotai",
	"moonshotai-cn",
	"nvidia",
	"openai",
	"openai-codex",
	"opencode-go",
	"qwen",
	"qwen-token-plan",
	"qwen-token-plan-cn",
	"qwen-token-plan-individual",
	"vercel-ai-gateway",
	"writer",
	"xai",
	"xiaomi-token-plan-ams",
	"xiaomi-token-plan-cn",
	"xiaomi-token-plan-sgp",
	"zai",
	"zai-coding-cn",
];

/** Reduce an endpoint-returned id to its bare model name for prefix matching. */
function normalizeModelId(id) {
	let normalized = id;
	if (normalized.startsWith("~")) normalized = normalized.slice(1);
	const colon = normalized.indexOf(":");
	if (colon !== -1) normalized = normalized.slice(0, colon);
	const slash = normalized.lastIndexOf("/");
	if (slash !== -1) normalized = normalized.slice(slash + 1);
	const parts = normalized.split(".");
	while (parts.length > 1 && MODEL_ID_QUALIFIERS.includes(parts[0])) parts.shift();
	return parts.join(".");
}

/** Read upstream pi-ai dist/providers/data/*.json (api -> id -> entry). */
function collectDataDir(dataDir) {
	const files = readdirSync(dataDir)
		.filter((name) => name.endsWith(".json") && !name.startsWith("."))
		.sort();
	if (files.length === 0) throw new Error(`No model data files found in ${dataDir}`);
	const models = new Map();
	let modelCount = 0;
	for (const file of files) {
		const provider = file.replace(/\.json$/, "");
		const data = JSON.parse(readFileSync(join(dataDir, file), "utf-8"));
		const byProvider = new Map();
		for (const entries of Object.values(data)) {
			for (const [id, entry] of Object.entries(entries)) {
				modelCount++;
				byProvider.set(id, {
					contextWindow: entry.contextWindow ?? DEFAULT_METADATA.contextWindow,
					maxTokens: entry.maxTokens ?? DEFAULT_METADATA.maxTokens,
					reasoning: entry.reasoning ?? DEFAULT_METADATA.reasoning,
					input: normalizeInput(entry.input),
				});
			}
		}
		models.set(provider, byProvider);
	}
	return { models, modelCount };
}

/** Fetch the live models.dev catalog, mirroring the upstream pipeline's filtering. */
async function collectModelsDev(url) {
	const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
	if (!response.ok) throw new Error(`models.dev API returned ${response.status}`);
	let data;
	try {
		data = await response.json();
	} catch (error) {
		throw new Error(`models.dev API returned invalid JSON from ${url}: ${error.message}`);
	}
	const models = new Map();
	let modelCount = 0;
	for (const [provider, catalog] of Object.entries(data)) {
		if (!catalog || typeof catalog !== "object" || !catalog.models) continue;
		const byProvider = new Map();
		for (const [id, entry] of Object.entries(catalog.models)) {
			// The upstream catalog only shipped tool-calling models; keep parity.
			if (entry.tool_call !== true) continue;
			modelCount++;
			byProvider.set(id, {
				contextWindow: entry.limit?.context ?? DEFAULT_METADATA.contextWindow,
				maxTokens: entry.limit?.output ?? DEFAULT_METADATA.maxTokens,
				reasoning: entry.reasoning === true,
				input: entry.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
			});
		}
		if (byProvider.size > 0) models.set(provider, byProvider);
	}
	return { models, modelCount };
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const { models, modelCount } =
		options.input.kind === "models-dev"
			? await collectModelsDev(options.modelsDevUrl)
			: collectDataDir(options.input.dir);
	const source =
		options.sourceLabel ??
		(options.input.kind === "models-dev"
			? `models.dev api.json (${new Date().toISOString().slice(0, 10)})`
			: "upstream @xiaoliyo/pi-ai dist/providers/data");

	// normalized model name -> list of distinct metadata variants
	const byName = new Map();
	const warnings = [];

	for (const [provider, byProvider] of models) {
		for (const [id, metadata] of byProvider) {
			const normalized = normalizeModelId(id);
			if (normalized.length === 0) continue;
			const existing = byName.get(normalized);
			const variant = { metadata, provider };
			if (!existing) {
				byName.set(normalized, [variant]);
				continue;
			}
			if (existing.some((candidate) => metadataKey(candidate.metadata) === metadataKey(metadata))) continue;
			warnings.push(`"${normalized}" has conflicting metadata (${provider} vs ${existing[0].provider})`);
			existing.push(variant);
		}
	}

	// One entry per normalized model name. Conflicting variants (same name
	// reported by different providers) are deduplicated to the largest limits.
	const entries = [];
	for (const [name, variants] of byName) {
		const winner = pickWinner(variants);
		if (metadataKey(winner.metadata) === metadataKey(DEFAULT_METADATA)) continue;
		entries.push({ prefixes: [name], metadata: winner.metadata });
	}

	// Merge identical metadata and sort for deterministic output.
	const byMetadata = new Map();
	for (const entry of entries) {
		const key = metadataKey(entry.metadata);
		const existing = byMetadata.get(key);
		if (existing) {
			existing.prefixes.push(...entry.prefixes);
		} else {
			byMetadata.set(key, { prefixes: [...entry.prefixes], metadata: entry.metadata });
		}
	}
	const merged = [...byMetadata.values()]
		.map((entry) => ({ ...entry, prefixes: [...new Set(entry.prefixes)].sort() }))
		.sort((a, b) => a.prefixes[0].localeCompare(b.prefixes[0]));

	const lines = [
		`/**`,
		` * Hand-maintained model metadata for discovered endpoints.`,
		` *`,
		` * Matches by model-name prefix (longest match wins); provider/region`,
		` * qualifiers in endpoint ids are stripped before matching. Falls back to`,
		` * defaults for unknown ids. No cost data: costs are user-editable per model`,
		` * in models.json and default to zero.`,
		` * Conflicting metadata for one model name is deduplicated to the largest`,
		` * context window / max tokens.`,
		` *`,
		` * AUTO-GENERATED by packages/ai/scripts/export-known-models.mjs.`,
		` * Source: ${source}. Regenerate with:`,
		` *   node packages/ai/scripts/export-known-models.mjs --models-dev`,
		` *   node packages/ai/scripts/export-known-models.mjs --data <pi-ai dist/providers/data>`,
		` */`,
		``,
		`export interface KnownModelMetadata {`,
		`	contextWindow: number;`,
		`	maxTokens: number;`,
		`	reasoning: boolean;`,
		`	input: ("text" | "image")[];`,
		`}`,
		``,
		`const DEFAULT_MODEL_METADATA: KnownModelMetadata = {`,
		`	contextWindow: 128000,`,
		`	maxTokens: 16384,`,
		`	reasoning: false,`,
		`	input: ["text"],`,
		`};`,
		``,
		`// Provider/region qualifiers that prefix a model id as "<qualifier>.<model>".`,
		`const MODEL_ID_QUALIFIERS = new Set([`,
		...MODEL_ID_QUALIFIERS.map((qualifier) => `	${JSON.stringify(qualifier)},`),
		`]);`,
		``,
		`/** Reduce an endpoint-returned id to its bare model name for prefix matching. */`,
		`function normalizeModelId(id: string): string {`,
		`	let normalized = id;`,
		`	if (normalized.startsWith("~")) normalized = normalized.slice(1);`,
		`	const colon = normalized.indexOf(":");`,
		`	if (colon !== -1) normalized = normalized.slice(0, colon);`,
		`	const slash = normalized.lastIndexOf("/");`,
		`	if (slash !== -1) normalized = normalized.slice(slash + 1);`,
		`	const parts = normalized.split(".");`,
		`	while (parts.length > 1 && MODEL_ID_QUALIFIERS.has(parts[0])) parts.shift();`,
		`	return parts.join(".");`,
		`}`,
		``,
		`const KNOWN_MODELS: ReadonlyArray<{ prefixes: readonly string[]; metadata: KnownModelMetadata }> = [`,
	];
	for (const entry of merged) {
		const prefixes = entry.prefixes.map((prefix) => JSON.stringify(prefix)).join(", ");
		const metadata = [
			`contextWindow: ${entry.metadata.contextWindow}`,
			`maxTokens: ${entry.metadata.maxTokens}`,
			`reasoning: ${entry.metadata.reasoning}`,
			`input: [${entry.metadata.input.map((value) => JSON.stringify(value)).join(", ")}]`,
		].join(", ");
		lines.push(`	{ prefixes: [${prefixes}], metadata: { ${metadata} } },`);
	}
	lines.push(`];`, ``);
	lines.push(`export function lookupKnownModel(id: string): KnownModelMetadata | undefined {`);
	lines.push(`	const normalizedId = normalizeModelId(id);`);
	lines.push(`	let match: KnownModelMetadata | undefined;`);
	lines.push(`	let longestPrefix = -1;`);
	lines.push(`	for (const entry of KNOWN_MODELS) {`);
	lines.push(`		for (const prefix of entry.prefixes) {`);
	lines.push(`			if (normalizedId.startsWith(prefix) && prefix.length > longestPrefix) {`);
	lines.push(`				match = entry.metadata;`);
	lines.push(`				longestPrefix = prefix.length;`);
	lines.push(`			}`);
	lines.push(`		}`);
	lines.push(`	}`);
	lines.push(`	return match;`);
	lines.push(`}`);
	lines.push(``);
	lines.push(`export function knownModelMetadata(id: string): KnownModelMetadata {`);
	lines.push(`	return lookupKnownModel(id) ?? DEFAULT_MODEL_METADATA;`);
	lines.push(`}`);
	lines.push(``);
	writeFileSync(options.out, lines.join("\n"), "utf-8");

	console.log(`Read ${models.size} providers, ${modelCount} models`);
	console.log(`Wrote ${merged.length} entries to ${options.out}`);
	if (warnings.length > 0) {
		console.warn(`${warnings.length} prefix conflicts deduplicated to the largest limits:`);
		for (const warning of [...new Set(warnings)].slice(0, 20)) console.warn(`  ${warning}`);
	}
}

await main();
