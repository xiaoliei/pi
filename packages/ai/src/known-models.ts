/**
 * Hand-maintained model metadata for discovered endpoints.
 *
 * Matches by id prefix (longest match wins) and falls back to defaults for
 * unknown ids. No cost data: costs are user-editable per model in models.json
 * and default to zero.
 */

export interface KnownModelMetadata {
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	input: ("text" | "image")[];
}

const DEFAULT_MODEL_METADATA: KnownModelMetadata = {
	contextWindow: 128000,
	maxTokens: 16384,
	reasoning: false,
	input: ["text"],
};

const KNOWN_MODELS: ReadonlyArray<{ prefixes: readonly string[]; metadata: KnownModelMetadata }> = [
	// OpenAI
	{
		prefixes: ["gpt-5"],
		metadata: { contextWindow: 400000, maxTokens: 128000, reasoning: true, input: ["text", "image"] },
	},
	{
		prefixes: ["gpt-4.1"],
		metadata: { contextWindow: 1000000, maxTokens: 32768, reasoning: true, input: ["text", "image"] },
	},
	{
		prefixes: ["gpt-4o"],
		metadata: { contextWindow: 128000, maxTokens: 16384, reasoning: false, input: ["text", "image"] },
	},
	{
		prefixes: ["o4-mini"],
		metadata: { contextWindow: 200000, maxTokens: 100000, reasoning: true, input: ["text", "image"] },
	},
	{ prefixes: ["o3", "o1"], metadata: { contextWindow: 200000, maxTokens: 100000, reasoning: true, input: ["text"] } },
	// Anthropic
	{
		prefixes: ["claude-opus-4"],
		metadata: { contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["text", "image"] },
	},
	{
		prefixes: ["claude-sonnet-4"],
		metadata: { contextWindow: 1000000, maxTokens: 64000, reasoning: true, input: ["text", "image"] },
	},
	{
		prefixes: ["claude-haiku-4"],
		metadata: { contextWindow: 200000, maxTokens: 32768, reasoning: true, input: ["text", "image"] },
	},
	{
		prefixes: ["claude-4-5", "claude-3-7", "claude-3-5"],
		metadata: { contextWindow: 200000, maxTokens: 64000, reasoning: true, input: ["text", "image"] },
	},
	// DeepSeek
	{
		prefixes: ["deepseek-reasoner"],
		metadata: { contextWindow: 128000, maxTokens: 16384, reasoning: true, input: ["text"] },
	},
	{
		prefixes: ["deepseek-chat"],
		metadata: { contextWindow: 128000, maxTokens: 16384, reasoning: false, input: ["text"] },
	},
	// Google
	{
		prefixes: ["gemini-3"],
		metadata: { contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["text", "image"] },
	},
	{
		prefixes: ["gemini-2.5"],
		metadata: { contextWindow: 1000000, maxTokens: 65536, reasoning: true, input: ["text", "image"] },
	},
	// Qwen
	{
		prefixes: ["qwen3.5"],
		metadata: { contextWindow: 128000, maxTokens: 16384, reasoning: true, input: ["text", "image"] },
	},
	{ prefixes: ["qwen3"], metadata: { contextWindow: 128000, maxTokens: 16384, reasoning: false, input: ["text"] } },
];

export function lookupKnownModel(id: string): KnownModelMetadata | undefined {
	let match: KnownModelMetadata | undefined;
	let longestPrefix = -1;
	for (const entry of KNOWN_MODELS) {
		for (const prefix of entry.prefixes) {
			if (id.startsWith(prefix) && prefix.length > longestPrefix) {
				match = entry.metadata;
				longestPrefix = prefix.length;
			}
		}
	}
	return match;
}

export function knownModelMetadata(id: string): KnownModelMetadata {
	return lookupKnownModel(id) ?? DEFAULT_MODEL_METADATA;
}
