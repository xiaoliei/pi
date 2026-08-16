# Providers and Endpoints

Pi has no built-in provider catalog. Providers are user-configured endpoints:
a base URL, an API key, and a protocol. Add them interactively with `/connect`
or by editing `~/.pi/agent/models.json`.

## Adding an endpoint

Run `/connect` in interactive mode and follow the wizard:

1. Base URL (e.g. `https://api.openai.com/v1`)
2. Endpoint id (auto-derived from the host, editable)
3. Name
4. API key (optional for keyless local servers)
5. Protocol (`openai-completions`, `openai-responses`, or `anthropic-messages`)
6. Extra headers (optional)
7. Discover and import models via the endpoint's `/models` API (optional)

Imported models get metadata from pi's hand-maintained `known-models` table and
default to zero cost; edit per-model metadata in the `/connect` management page.

If the endpoint has no `/models` API, skip discovery and add models by hand in
`models.json` (see [models.md](models.md)).

## API keys

Endpoint API keys are stored in `models.json`. Values support:

- literal strings
- environment interpolation: `$ENV_VAR` or `${ENV_VAR}`
- shell commands: `!command` (stdout is trimmed and used as the value)

Keyless local servers (llama.cpp, vLLM) simply omit `apiKey`.

## First run

When no models are available, interactive mode opens `/connect` automatically.
Press Escape to skip. Non-interactive runs (`-p`) fail with a message pointing
at `/connect`.

## Where credentials live

`~/.pi/agent/auth.json` may still contain API keys from older sessions; those
entries stay inert and are never cleaned up automatically. New configurations
keep endpoint keys in `models.json`.
