# Environment Variables

Endpoint API keys are configured per endpoint in `~/.pi/agent/models.json` via
`/connect` or manual edits. Values may be literals, `$ENV_VAR` interpolations,
or `!command` executions — so environment variables still work, but they are
referenced explicitly per endpoint instead of being auto-discovered by provider
name.

The built-in provider key conventions (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`GEMINI_API_KEY`, etc.) no longer exist: no provider catalog reads them.

General pi variables remain:

| Variable | Purpose |
| --- | --- |
| `PI_CODING_AGENT_DIR` | Agent config directory (default `~/.pi/agent`) |
| `PI_CODING_AGENT_SESSION_DIR` | Session storage directory (overridden by `--session-dir`) |
| `PI_OFFLINE` | Disable startup network operations when `1`/`true`/`yes` |
| `PI_TELEMETRY` | Override install telemetry (`1`/`true`/`yes` or `0`/`false`/`no`) |
| `PI_PACKAGE_DIR` | Override package directory (for Nix/Guix store paths) |
| `PI_SHARE_VIEWER_URL` | Base URL for `/share` (default `https://pi.dev/session/`) |
