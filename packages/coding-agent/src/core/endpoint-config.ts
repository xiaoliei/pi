/**
 * /connect endpoint configuration: surgical edits of `<agentDir>/models.json`
 * (JSONC) via jsonc-parser, plus discovery-import helpers.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type DiscoveredEndpointModel, knownModelMetadata } from "@xiaoliyo/pi-ai";
import { applyEdits, modify } from "jsonc-parser";
import {
	ModelConfig,
	type ModelsJsonModel,
	type ModelsJsonProvider,
	validateModelsConfigContent,
} from "./model-config.ts";

export type EndpointApi = "anthropic-messages" | "openai-completions" | "openai-responses";

export interface EndpointForm {
	id: string;
	name: string;
	baseUrl: string;
	api: EndpointApi;
	apiKey?: string;
	headers?: Record<string, string>;
}

const ENDPOINT_API_VALUES: ReadonlySet<string> = new Set([
	"anthropic-messages",
	"openai-completions",
	"openai-responses",
]);

const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isEndpointApi(value: string): value is EndpointApi {
	return ENDPOINT_API_VALUES.has(value);
}

export function isEndpointIdValid(id: string): boolean {
	return PROVIDER_ID_RE.test(id);
}

/** Derive a provider id slug from a baseUrl host (e.g. `relay.example.com` -> `relay-example-com`). */
export function deriveEndpointId(baseUrl: string): string {
	try {
		const host = new URL(baseUrl).hostname;
		const slug = host
			.replace(/[^A-Za-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.toLowerCase();
		return slug.length > 0 ? slug : "endpoint";
	} catch {
		return "endpoint";
	}
}

export function uniqueEndpointId(existing: ReadonlySet<string>, baseUrl: string): string {
	const base = isEndpointIdValid(deriveEndpointId(baseUrl)) ? deriveEndpointId(baseUrl) : "endpoint";
	if (!existing.has(base)) return base;
	for (let index = 2; ; index++) {
		const candidate = `${base}-${index}`;
		if (!existing.has(candidate)) return candidate;
	}
}

function formattingOptionsFor(content: string): { insertSpaces: boolean; tabSize: number; eol: string } {
	return {
		insertSpaces: !/^\t/m.test(content),
		tabSize: 2,
		eol: content.includes("\r\n") ? "\r\n" : "\n",
	};
}

async function readModelsJsonText(modelsPath: string): Promise<string> {
	try {
		return await readFile(modelsPath, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return '{\n\t"providers": {}\n}';
		}
		throw error;
	}
}

async function writeModelsJson(modelsPath: string, content: string): Promise<void> {
	await mkdir(dirname(modelsPath), { recursive: true });
	await writeFile(modelsPath, content, "utf-8");
}

/** Refuse to overwrite a models.json that is currently unparsable or schema-invalid. */
async function assertCurrentConfigValid(modelsPath: string, content: string): Promise<void> {
	const error = validateModelsConfigContent(content);
	if (error) {
		throw new Error(`Not writing models.json: ${error}\n\nFile: ${modelsPath}`);
	}
}

function buildProviderEntry(
	entry: EndpointForm,
	models?: ModelsJsonModel[],
	extra?: Partial<ModelsJsonProvider>,
): ModelsJsonProvider {
	const provider: ModelsJsonProvider = {
		name: entry.name,
		baseUrl: entry.baseUrl,
		api: entry.api,
		...(entry.apiKey ? { apiKey: entry.apiKey } : {}),
		...(entry.headers && Object.keys(entry.headers).length > 0 ? { headers: entry.headers } : {}),
		...(models !== undefined ? { models } : {}),
		...(extra ?? {}),
	};
	return provider;
}

/** Write one endpoint entry (add or full replace) into models.json. */
export async function writeEndpointEntry(
	modelsPath: string,
	entry: EndpointForm,
	models?: ModelsJsonModel[],
	extra?: Partial<ModelsJsonProvider>,
): Promise<void> {
	const content = await readModelsJsonText(modelsPath);
	await assertCurrentConfigValid(modelsPath, content);
	const provider = buildProviderEntry(entry, models, extra);
	const edits = modify(content, ["providers", entry.id], provider, {
		formattingOptions: formattingOptionsFor(content),
	});
	const next = applyEdits(content, edits);
	const nextError = validateModelsConfigContent(next);
	if (nextError) throw new Error(`Refusing invalid models.json write: ${nextError}`);
	await writeModelsJson(modelsPath, next);
}

/** Remove a whole endpoint entry from models.json. */
export async function deleteEndpointEntry(modelsPath: string, id: string): Promise<void> {
	const content = await readModelsJsonText(modelsPath);
	await assertCurrentConfigValid(modelsPath, content);
	const edits = modify(content, ["providers", id], undefined, {
		formattingOptions: formattingOptionsFor(content),
	});
	const next = applyEdits(content, edits);
	const nextError = validateModelsConfigContent(next);
	if (nextError) throw new Error(`Refusing invalid models.json write: ${nextError}`);
	await writeModelsJson(modelsPath, next);
}

/** Replace the `models` array of an endpoint, preserving everything else. */
export async function updateEndpointModels(modelsPath: string, id: string, models: ModelsJsonModel[]): Promise<void> {
	const content = await readModelsJsonText(modelsPath);
	await assertCurrentConfigValid(modelsPath, content);
	const edits = modify(content, ["providers", id, "models"], models, {
		formattingOptions: formattingOptionsFor(content),
	});
	const next = applyEdits(content, edits);
	const nextError = validateModelsConfigContent(next);
	if (nextError) throw new Error(`Refusing invalid models.json write: ${nextError}`);
	await writeModelsJson(modelsPath, next);
}

/** Update selected fields of an endpoint entry (deep-merged per top-level key). */
export async function updateEndpointEntry(
	modelsPath: string,
	id: string,
	patch: Partial<ModelsJsonProvider>,
): Promise<void> {
	const config = await ModelConfig.load(modelsPath);
	const configError = config.getError();
	if (configError) throw new Error(configError);
	const current = config.getProvider(id);
	if (!current) throw new Error(`Endpoint "${id}" not found in models.json`);
	const content = await readModelsJsonText(modelsPath);
	const merged: ModelsJsonProvider = { ...current, ...patch };
	const edits = modify(content, ["providers", id], merged, {
		formattingOptions: formattingOptionsFor(content),
	});
	const next = applyEdits(content, edits);
	const nextError = validateModelsConfigContent(next);
	if (nextError) throw new Error(`Refusing invalid models.json write: ${nextError}`);
	await writeModelsJson(modelsPath, next);
}

/**
 * Per-model api preference: OpenAI's own models answer the Responses API even
 * when the endpoint protocol is openai-completions, so discovered OpenAI
 * models are imported as openai-responses.
 */
export function preferredDiscoveryApi(entryApi: EndpointApi, modelId: string): string {
	if (entryApi === "openai-completions" && /^(gpt-5|gpt-4\.1|o[134]|o1|o3)/u.test(modelId)) {
		return "openai-responses";
	}
	return entryApi;
}

/** Build models.json model definitions from a discovery result. */
export function modelDefinitionsFromDiscovery(
	discovered: readonly DiscoveredEndpointModel[],
	entryApi: EndpointApi,
): ModelsJsonModel[] {
	return discovered.map((model) => {
		const metadata = knownModelMetadata(model.id);
		return {
			id: model.id,
			...(model.name ? { name: model.name } : {}),
			enabled: true,
			api: preferredDiscoveryApi(entryApi, model.id),
			reasoning: metadata.reasoning,
			input: metadata.input,
			contextWindow: metadata.contextWindow,
			maxTokens: metadata.maxTokens,
		};
	});
}

/** Re-discovery merge: keep existing entries untouched, append only new ids. */
export function mergeDiscoveredModels(
	existing: readonly ModelsJsonModel[] | undefined,
	discovered: readonly ModelsJsonModel[],
): ModelsJsonModel[] {
	const merged = existing ? [...existing] : [];
	for (const model of discovered) {
		if (!merged.some((entry) => entry.id === model.id)) merged.push(model);
	}
	return merged;
}
