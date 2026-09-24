# LM Studio Model Loader Plugin (for opencode)

Ensures that — before [opencode](https://opencode.ai) sends any LLM request to LM Studio — **the target model is loaded and the engine is actually ready to infer**, that only a single model stays loaded at a time, and that state changes such as LM Studio's Idle TTL / Auto-Evict / engine-dies-after-load are handled gracefully.

> 🌏 中文版：[README.md](README.md) · English version: this file.

## Features

- **Ready-before-request guarantee**: intercepts every request via the `chat.params` hook and does not let it through until the target model is loaded *and* ready to infer; if the engine is not ready yet, it waits for it — fixing the `{"message":"Model is unloaded."}` error.
- **Single-model management**: automatically unloads all other loaded models before loading a new one (`alwaysSingleModel`), so multiple models never compete for GPU/RAM at once.
- **Concurrency race protection**: a global serialized queue plus per-model in-flight merging prevents two models from unloading each other while loading concurrently (the main race when the main model / small_model / subagents fire requests at the same time after opening a session).
- **Real inferability check**: after `load`, polls `loaded_instances` and pings the engine with a minimal chat completion (`max_tokens=1`) until it can actually produce output; if the ping detects the engine died after loading, it reloads automatically.
- **Verified cache**: in steady state, requests pass straight through with zero added latency; the cache is keyed by instanceId + TTL and self-invalidates when the engine instance is replaced.
- **Automatic recovery**: the `event` hook watches `session.error`; when it detects "Model is unloaded" it invalidates the cache and **preloads in the background**, so the user's next retry succeeds immediately.
- **context_length support**: loads the model with your configured `limit.context` (from `opencode.jsonc`), so LM Studio no longer loads it at the model's maximum default context.
- **Injectable fetch**: `fetchImpl` is injectable (used by the tests); defaults to `globalThis.fetch`.

## How it works

```
User sends an LLM request
        │
        ▼
chat.params hook intercepts
  ① Filter: only handle requests whose providerID === "lmstudio"
  ② Resolve the full model key (if the model isn't loaded → trigger the load flow)
  ③ Record context_length and session → model mapping
  ④ Fast path: verified cache hit with no conflict → let through (zero latency)
  ⑤ Otherwise, serialized ensure:
       unload (evict other models) → load → poll instances → ping readiness
       all three load calls carry context_length (from the model's limit.context)
       the request is only released once everything is ready
        │
        ▼
Original request passes → LLM request succeeds immediately
```

When the engine is evicted by Idle TTL / Auto-Evict / a crash:

```
session.error ("Model is unloaded")
        │
        ▼
event hook detects it → invalidates the verified cache → background preload (reusing context_length)
        │
        ▼
User retries → fast path hit → success
```

## Installation

Copy `plugins/lmstudio-model-loader.js` into opencode's plugins directory (create it if missing):

```bash
mkdir -p ~/.config/opencode/plugins
cp plugins/lmstudio-model-loader.js ~/.config/opencode/plugins/
```

opencode auto-loads every plugin under `~/.config/opencode/plugins/` at startup — no further setup required.

## Configuration

The plugin handles requests whose `providerID === "lmstudio"` and defers to the model settings passed in via `chat.params`. Add LM Studio to the `provider` section of your `opencode.jsonc`:

```jsonc
{
  "provider": {
    "lmstudio": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "LMStudio",
      "options": {
        "baseURL": "http://127.0.0.1:1234/v1"
      },
      "models": {
        "qwen3.6-35b-a3b-brainwaves-nex-uncensored-qx64-hi-mlx": {
          "name": "Qwen3.6 35B A3B (MLX)",
          "attachment": true,
          "modalities": { "input": ["text", "image"], "output": ["text"] },
          "limit": {
            "context": 145328,
            "output": 8192
          },
          "options": { "maxOutputTokens": 8192 }
        }
      }
    }
  }
}
```

### context_length resolution order

| Priority | Source | Description |
|---|---|---|
| 1 | `models.<id>.limit.context` | The model's setting in `opencode.jsonc` (145328 in the example above) — **resolved dynamically** on every request |
| 2 | Plugin option `contextLength` | Fallback, used when the model has no `limit` configured |
| — | Neither | `context_length` is omitted and LM Studio loads the model at its default |

To change the loaded context, just edit the `limit.context` number in `opencode.jsonc` — the plugin picks it up automatically, no plugin changes needed.

## Plugin options

When the plugin is loaded programmatically (e.g. registered in opencode's config), the following options are accepted:

| Option | Default | Description |
|---|---|---|
| `baseURL` | `http://127.0.0.1:1234` | LM Studio API base URL (normalized automatically; a `/v1` suffix is fine) |
| `providerID` | `"lmstudio"` | Provider ID to handle |
| `alwaysSingleModel` | `true` | Unload all loaded models before loading a new one |
| `fetchImpl` | `globalThis.fetch` | fetch implementation (injectable for tests) |
| `loadTimeoutMs` | `300000` | Catalog poll deadline after load |
| `readyTimeoutMs` | `300000` | Ping readiness verification deadline |
| `unloadCompletionTimeoutMs` | `15000` | Unload-completion poll deadline |
| `maxLoadRetries` | `3` | Load retry count (backoff on transient errors) |
| `loadRetryBaseDelayMs` | `1500` | Load retry backoff base |
| `readyTTLMs` | `90000` | Verified cache TTL |
| `pingEnabled` | `true` | Whether to enable the ping readiness check |
| `pingMaxTokens` | `1` | `max_tokens` used by the ping |
| `pollIntervalMs` | `1000` | Catalog poll interval |
| `pingRetryDelayMs` | `1500` | Ping retry interval on failure |
| `nudgePollTimeoutMs` | `15000` | Poll deadline for reloading after an "unloaded" detection |
| `fetchTimeoutMs` | `10000` | General fetch timeout (fetchModels / unloadInstance / chatPing) |
| `loadFetchTimeoutMs` | `30000` | Fetch timeout for the load request |
| `maxSessionModels` | `500` | session→model record cap (oldest entry evicted when exceeded) |
| `apiKey` | `undefined` | LM Studio API token (also picked up dynamically from `chat.params` provider options) |
| `contextLength` | `undefined` | `context_length` fallback for loading (primary source is the model's `limit.context`) |

## Tests

The project ships unit and system tests (no real LM Studio needed — they use an injectable mock fetch):

```bash
# Unit tests (pure functions)
node --test tests/lmstudio-model-loader/unit.test.mjs

# System tests (full hooks flow + mock fetch)
node --test tests/lmstudio-model-loader/system.test.mjs

# Everything
node --test tests/lmstudio-model-loader/
```

## Build / Release

`build_release_lmstudio.sh` runs unit tests → system tests → creates the `release/` folder (auto-created if missing) and copies the plugin and tests into it:

```bash
./build_release_lmstudio.sh
```

## Project layout

```
.
├── plugins/
│   └── lmstudio-model-loader.js     # the plugin itself (its only export is default)
├── tests/
│   └── lmstudio-model-loader/
│       ├── helpers.mjs              # test helper that extracts pure functions from source
│       ├── unit.test.mjs            # unit tests (pure functions)
│       └── system.test.mjs          # system tests (hooks + mock fetch)
├── build_release_lmstudio.sh        # build / release script
└── release/                         # build artifacts (auto-created by the script)
```

> ⚠️ Note: the plugin file **must only have one export (`export default`)**. opencode's plugin loader iterates over every export of the module and instantiates each one as a plugin; any additional named export would be misinterpreted as a plugin and cause the load to fail. All helpers are module-internal functions.