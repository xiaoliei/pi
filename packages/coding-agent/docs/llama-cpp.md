# llama.cpp

The bundled llama.cpp extension is gone. Run the
[llama.cpp server](https://github.com/ggml-org/llama.cpp) yourself and add it
as a regular endpoint with `/connect`:

1. Start the server, e.g. `llama-server -m model.gguf --port 8080`.
2. In pi, run `/connect`.
3. Base URL: `http://127.0.0.1:8080/v1`
4. Leave the API key empty (keyless local server).
5. Protocol: `openai-completions`
6. Choose "Discover and import models" — llama.cpp exposes its loaded model
   through `/models`.

Per-model context sizes and other server options are configured in
[llama.cpp model presets](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#model-presets);
pi's imported model metadata can be edited in the `/connect` management page.

The old `LLAMA_BASE_URL` environment variable and `/llama` model management UI
are removed.
