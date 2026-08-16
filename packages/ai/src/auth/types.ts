import type { ProviderEnv, ProviderHeaders } from "../types.ts";

/**
 * Request auth for a single model request. If a value cannot be expressed as
 * `apiKey`, `headers`, or `baseUrl`, it is provider config, not auth.
 */
export interface ModelAuth {
	apiKey?: string;
	headers?: ProviderHeaders;
	baseUrl?: string;
	env?: ProviderEnv;
}

/**
 * Stored api-key credential. `env` holds provider-scoped environment/config
 * values referenced by configured headers.
 */
export interface ApiKeyCredential {
	type: "api_key";
	key?: string;
	env?: ProviderEnv;
}

/** One type-tagged credential per provider — the shape of today's auth.json. */
export type Credential = ApiKeyCredential;

/** Non-secret credential metadata for account/status enumeration. */
export interface CredentialInfo {
	providerId: string;
	type: Credential["type"];
}

/** Optional cancellation for public auth and credential operations. */
export interface AuthOperationOptions {
	signal?: AbortSignal;
}

/**
 * App-owned credential storage, keyed by `Provider.id`, one credential per
 * provider. `modify` is the only write path, so every mutation is a
 * serialized read-modify-write.
 *
 * Error semantics: `read` resolves `undefined` for missing entries. Methods
 * reject only on storage failure; `Models` wraps such rejections in
 * `ModelsError` with code "auth". Best-effort stores that serve an in-memory
 * view and record persistence errors internally (like coding-agent's
 * AuthStorage) are valid implementations.
 */
export interface CredentialStore {
	/**
	 * Read the stored credential. Display/status use; resolved request auth
	 * comes from `Models.getAuth()`.
	 */
	read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined>;

	/**
	 * List stored credential metadata without resolving or exposing secrets.
	 * Implementations must not execute configured API-key commands while listing.
	 */
	list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]>;

	/**
	 * Serialized write — the only write path. `fn` sees the current credential;
	 * return the new credential, or undefined to leave the entry unchanged.
	 * Mutual exclusion per provider id, cross-process too where the backing
	 * store supports it (e.g. a file lock). Resolves with the post-write
	 * credential. Rejections from `fn` propagate.
	 */
	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined>;

	/** Remove a credential (logout). Implementations serialize this against `modify`. */
	delete(providerId: string, options?: AuthOperationOptions): Promise<void>;
}

/** Environment access for auth/header resolution. Injectable for tests and browsers. */
export interface AuthContext {
	env(name: string): Promise<string | undefined>;
}

/** Result of resolving auth for a model. */
export interface AuthResult {
	auth: ModelAuth;
	/** Provider-scoped environment/config values resolved from credentials and ambient context. */
	env?: ProviderEnv;
	/** Human-readable label for status UI, e.g. "API key". */
	source?: string;
}

export interface AuthCheck {
	source?: string;
	type: "api_key";
}

/**
 * Api-key auth: resolves the configured key (models.json literal, `$ENV`
 * interpolation, `!command`, stored credential, or extension-provided key).
 */
export interface ApiKeyAuth {
	/** Display name, e.g. "API key". */
	name: string;

	/**
	 * Optional side-effect-free availability check. Use this when `resolve()` may
	 * execute commands or perform other request-time work. Missing means Models
	 * checks availability by resolving auth.
	 */
	check?(input: {
		ctx: AuthContext;
		credential?: ApiKeyCredential;
		signal: AbortSignal;
	}): Promise<AuthCheck | undefined>;

	/**
	 * Resolve auth from the stored credential and/or configured sources.
	 * undefined = not configured.
	 */
	resolve(input: {
		ctx: AuthContext;
		credential?: ApiKeyCredential;
		signal: AbortSignal;
	}): Promise<AuthResult | undefined>;
}

/**
 * Provider auth. Keyless endpoints (local llama.cpp/vLLM servers) legitimately
 * carry no auth; `Models.getAuth()` then reports the provider as unconfigured.
 */
export interface ProviderAuth {
	apiKey?: ApiKeyAuth;
}
