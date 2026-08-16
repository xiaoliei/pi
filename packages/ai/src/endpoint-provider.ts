import { lazyStream } from "./api/lazy.ts";
import { getApiProvider } from "./api-registry.ts";
import type { Provider } from "./models.ts";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions, StreamOptions } from "./types.ts";

/** Protocols a user-configured endpoint may speak. */
export type EndpointApi = "anthropic-messages" | "openai-completions" | "openai-responses";

export interface EndpointProviderConfig {
	id: string;
	name: string;
	baseUrl: string;
	api: EndpointApi;
	/** Optional; keyless local servers (llama.cpp, vLLM) omit it. */
	apiKey?: string;
	headers?: Record<string, string>;
	/** Endpoint-level compat fallback applied to models that carry none. */
	compat?: Model<Api>["compat"];
	/** Static, materialized model list. Models must carry `provider` = `id`. */
	models: Model<Api>[];
}

/**
 * Builds a `Provider` from a user-configured endpoint: one endpoint maps to
 * one provider. Model lists are static (materialized from models.json or a
 * discovery import); streaming dispatches through the global api-registry by
 * `model.api`, so mixed-protocol relays work per model.
 */
export function endpointProvider(config: EndpointProviderConfig): Provider {
	const models = config.models.map((model) =>
		model.compat === undefined && config.compat !== undefined ? { ...model, compat: config.compat } : model,
	);
	const dispatch = (
		model: Model<Api>,
		context: Context,
		options: StreamOptions | undefined,
		simple: boolean,
	): AssistantMessageEventStream => {
		const api = getApiProvider(model.api);
		if (!api) {
			return lazyStream(model, async () => {
				throw new Error(`No API provider registered for api: ${model.api}`);
			});
		}
		return simple
			? api.streamSimple(model, context, options as SimpleStreamOptions)
			: api.stream(model, context, options);
	};

	return {
		id: config.id,
		name: config.name,
		baseUrl: config.baseUrl,
		headers: config.headers,
		auth: config.apiKey
			? {
					apiKey: {
						name: "API key",
						resolve: async () => ({ auth: { apiKey: config.apiKey, headers: config.headers } }),
					},
				}
			: {},
		getModels: () => models,
		stream: (model, context, options) => dispatch(model, context, options, false),
		streamSimple: (model, context, options) => dispatch(model, context, options, true),
	};
}
