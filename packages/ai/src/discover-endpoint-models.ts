import type { EndpointApi } from "./endpoint-provider.ts";

export interface DiscoverEndpointModelsOptions {
	api: EndpointApi;
	baseUrl: string;
	apiKey?: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

export interface DiscoveredEndpointModel {
	id: string;
	name?: string;
}

interface ModelListResponse {
	data?: unknown;
}

/**
 * Optional model discovery through an endpoint's `GET {baseUrl}/models` API.
 * OpenAI-style protocols authenticate with `Authorization: Bearer`;
 * anthropic-messages uses `x-api-key` plus `anthropic-version`. Responses use
 * the OpenAI list shape `{data: [{id, display_name?}]}`; Anthropic's
 * `/models` endpoint returns the same shape, so one parser covers both.
 */
export async function discoverEndpointModels(
	options: DiscoverEndpointModelsOptions,
): Promise<DiscoveredEndpointModel[]> {
	const baseUrl = options.baseUrl.replace(/\/+$/u, "");
	const headers: Record<string, string> = { ...(options.headers ?? {}) };
	if (options.api === "anthropic-messages") {
		headers["x-api-key"] = options.apiKey ?? "";
		headers["anthropic-version"] = "2023-06-01";
	} else {
		headers.Authorization = `Bearer ${options.apiKey ?? ""}`;
	}

	let response: Response;
	try {
		response = await fetch(`${baseUrl}/models`, { headers, signal: options.signal });
	} catch (error) {
		throw new Error(`Model discovery request failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!response.ok) {
		throw new Error(`Model discovery failed (${response.status} ${response.statusText})`);
	}

	let body: ModelListResponse;
	try {
		body = (await response.json()) as ModelListResponse;
	} catch (error) {
		throw new Error(`Model discovery returned invalid JSON`, { cause: error });
	}
	if (!Array.isArray(body.data)) {
		throw new Error(`Model discovery response missing "data" array`);
	}

	const models: DiscoveredEndpointModel[] = [];
	for (const entry of body.data) {
		if (typeof entry !== "object" || entry === null) continue;
		const { id, display_name: displayName } = entry as { id?: unknown; display_name?: unknown };
		if (typeof id !== "string" || id.length === 0) continue;
		models.push({
			id,
			...(typeof displayName === "string" && displayName.length > 0 ? { name: displayName } : {}),
		});
	}
	return models;
}
