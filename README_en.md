# LM Studio Model Loader Plugin（lmstudio-model-loader）

> 📦 Repository: <https://github.com/wclinRD/opencode_lmstudio_loader>
> 🌏 中文版：[README.md](README.md) · English: this file

Automatically **unloads the old model and loads the target model** for opencode before every LM Studio (`lmstudio/*`) request, keeping only a single model resident in memory and guaranteeing the model engine can actually run inference **before the request is dispatched**.

> This plugin is built for the **opencode V2 plugin API** and verified end-to-end on this machine (2026-10-08):
> - **opencode 2.0.20 + real LM Studio**: cold-start ensure (catalog → load → poll → ping) → real inference succeeded
> - **opencode 2.0.20 + mock server**: `model.request` hook (primary/title), `retry` hook (decision override delay 1605→0), event subscription, failure recovery → `session.execution.succeeded`
> - Unit tests 16/16 pass (`node --test`)

---

## Features

| Feature | Description |
|---|---|
| Auto load | Before every LLM request (`model.request` hook), load the target model if it is not loaded |
| Auto unload | `alwaysSingleModel` (default `true`): unload all loaded models before loading a new one |
| **Readiness check (ping)** | After load, run a minimal chat completion (`max_tokens=1`) to confirm the engine can infer, then release the request |
| **Concurrency serialization** | Concurrent loads of different models run through a **serialized queue** so A is never unloaded right after being loaded by B (fixes the `Model is unloaded` root cause) |
| **Fast path + cache** | Verified & sole-loaded → zero-latency pass-through (verified cache with instanceId + TTL) |
| **Reactive preload** | Subscribes to `session.execution.failed`; on `Model is unloaded` → invalidate cache and preload in background, so retries succeed |
| **Failure auto-recovery** | `retry` hook: on provider request failure, re-ensure synchronously; on success override `decision = {retry:true, delay:0}` for an immediate retry |
| **Unload completion wait** | unload is async; poll until the instance truly disappears before loading the new model |
| **Load retries** | Transient errors (503/429/network/busy…) back off and retry; hard failures (404 not found) do not retry |
| Provider filter | Non-`lmstudio` providers are completely untouched (hooks registered scoped to `{ providerID }`) |

## File structure

```
opencode_lmstudio_loader/
├── lmstudio-model-loader.js   # Plugin main file (single file, export default only)
├── package.json               # For tests (type: module)
├── build_release.sh           # Build script (syntax check + tests + copy to release/)
├── tests/
│   ├── lmstudio-model-loader.test.mjs  # Unit tests (injected fake server, no LM Studio needed)
│   └── live.test.mjs                   # System tests (real LM Studio, SKIP if not running)
├── README.md                  # Documentation (Traditional Chinese)
└── README_en.md               # Documentation (English)
```

> ⚠️ **V2 plugin format requirement**
> The opencode 2.x plugin loader requires `export default` to be a plain **`{ id, setup }` object**:
> ```js
> export default {
>   id: "lmstudio-model-loader",
>   async setup(ctx) { /* ... */ return cleanup; },
> };
> ```
> - `import { Plugin } from "@opencode/plugin"` **fails to resolve** on 2.0.20 (even when the package is installed); do not use it
> - If `default` is not a valid object, the log shows
>   `Plugin must export a default definition with an id and an effect or setup function`
> - Keep the file to a **single default export**; do not export helper functions

---

## Prerequisites

- **opencode ≥ 2.0** (V2 plugin API; verified on 2.0.20. opencode 1.x / V1 API is **NOT** compatible)
- **LM Studio** running with its API server enabled (default `http://127.0.0.1:1234`)
- An `lmstudio` provider already defined in your opencode config (see “Configure opencode” below)

---

## Installation

### Method 1: Auto-discovery (simplest, default options)

Get the repo, then copy `lmstudio-model-loader.js` into opencode's plugin directory. Note the **plural** `plugins/`:

```bash
git clone https://github.com/wclinRD/opencode_lmstudio_loader.git
cd opencode_lmstudio_loader

# Global install (shared by all projects) — verified on 2.0.20
cp lmstudio-model-loader.js ~/.config/opencode/plugins/

# Or project-scoped (repo root of the project) — verified on 2.0.20
mkdir -p .opencode/plugins
cp lmstudio-model-loader.js .opencode/plugins/
```

**Restart opencode** and you are done.

### Method 2: Custom options (config `plugins`, **must be a directory**)

As of opencode 2.0.20, the `package` field in the config `plugins` array only accepts **directory paths** (pointing at a `.js` file is rejected with `configured plugin path must be a directory`). For custom options:

```bash
# 1. Create a directory and place the plugin as index.js inside it, with a package.json
mkdir -p ~/.config/opencode/plugins/lmstudio-model-loader
cp lmstudio-model-loader.js ~/.config/opencode/plugins/lmstudio-model-loader/index.js
cat > ~/.config/opencode/plugins/lmstudio-model-loader/package.json <<'EOF'
{
  "name": "lmstudio-model-loader",
  "version": "3.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js" }
}
EOF
```

```jsonc
// 2. Point opencode.json at that directory; options become ctx.options
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/Users/YOU/.config/opencode/plugins/lmstudio-model-loader",
      "options": {
        "baseURL": "http://127.0.0.1:1234",
        "providerID": "lmstudio",
        "alwaysSingleModel": true,
        "readyTTLMs": 90000
      }
    }
  ]
}
```

> Notes:
> - `plugins` (plural, array of objects) is the **V2 format**; the V1 `plugin` (singular, `[path, options]` tuple) no longer applies
> - If the same plugin is also auto-discovered from a `plugins/` directory it will be loaded twice; when using custom options **do not** also place it there

### Options (`ctx.options`)

| Option | Default | Description |
|---|---|---|
| `baseURL` | `http://127.0.0.1:1234` | LM Studio API address (when not set explicitly, taken from provider settings baseURL with `/v1` stripped) |
| `providerID` | `lmstudio` | Provider name to intercept |
| `alwaysSingleModel` | `true` | Unload all loaded models before loading a new one |
| `loadTimeoutMs` | `300000` | Timeout for catalog polling after load |
| `readyTimeoutMs` | `300000` | Timeout for ping readiness verification |
| `unloadCompletionTimeoutMs` | `15000` | Timeout for unload-completion polling |
| `maxLoadRetries` | `3` | Load retry count |
| `loadRetryBaseDelayMs` | `1500` | Load retry backoff base |
| `readyTTLMs` | `90000` | Verified cache TTL |
| `pingEnabled` | `true` | Enable ping readiness verification |
| `pingMaxTokens` | `1` | max_tokens used by ping |
| `pingRetryDelayMs` | `1500` | Ping failure retry interval |
| `pollIntervalMs` | `1000` | Catalog / unload-polling interval |
| `nudgePollTimeoutMs` | `15000` | Poll timeout for nudge reload after detecting unloaded |
| `fetchTimeoutMs` | `10000` | General API request timeout |
| `loadFetchTimeoutMs` | `30000` | load/unload API request timeout |
| `maxSessionModels` | `500` | Session→model record cap (LRU eviction) |
| `maxRecoveryAttempts` | `2` | `retry` hook recovery cap (attempt starts at 2) |
| `apiKey` | none | LM Studio API key (usually not needed) |

---

## Configure opencode（lmstudio provider）

Your `opencode.json` (in `~/.config/opencode/opencode.json` or the project's `.opencode/`) needs an `lmstudio` provider with model definitions so the plugin can intercept requests. This is the **V2 shape** (`providers` plural + `package` + `settings`, verified on 2.0.20):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "lmstudio": {
      "package": "aisdk:@ai-sdk/openai-compatible",
      "name": "LMStudio",
      "settings": {
        "baseURL": "http://127.0.0.1:1234/v1",
        "apiKey": "lm-studio"
      },
      "models": {
        "qwen3.6-35b-a3b": {
          "name": "qwen3.6-35b-a3b",
          "limit": { "context": 131072, "output": 8192 }
        }
      }
    }
  }
}
```

> Prefer the **full key** (including the publisher prefix, e.g. `qwen/qwen3.8-27b`) from the LM Studio model library. List full keys with:
> ```bash
> curl -s http://127.0.0.1:1234/api/v1/models | jq -r '.models[].key'
> ```

---

## Usage

1. Restart opencode so the plugin loads and registers its hooks.
2. Switch to any `lmstudio/*` model with `/model`.
3. **No manual steps needed** — before each request the plugin automatically: checks what is loaded → unloads if different → loads the target → **pings to confirm the engine is ready** → releases the request.

### Verify the plugin loaded

```bash
# You should see "loading plugin ... lmstudio-model-loader" (or its directory)
grep -F "loading plugin" ~/.local/share/opencode/log/opencode.log | tail

# It must show no plugin load failures
grep -F "failed to load plugin" ~/.local/share/opencode/log/opencode.log | tail
# (If you previously used the V1 config format, also check for "configured plugin path must be a directory")
```

Confirm LM Studio has auto-loaded the matching model:

```bash
curl -s http://127.0.0.1:1234/api/v1/models \
  | jq -r '.models[] | select((.loaded_instances // []) | length > 0) | .key'
```

> The plugin's `[lmstudio]` console messages go to the opencode server process stdout
> (the terminal running `opencode serve`; under `opencode run --standalone` they do not appear in opencode.log).

---

## How it works

`setup(ctx)` registers three mechanisms and returns a cleanup function (run on unload):

### 1. `model.request` hook（ensure readiness before dispatch; scoped `{ providerID: "lmstudio" }`）

Covers all request kinds `primary / title / compaction / generate`（the V2 counterpart of V1's `chat.params`）:

```
request dispatched
  └─ model.request hook（only providerID = "lmstudio"）
       ├─ 1. Query currently loaded models（GET /api/v1/models）
       ├─ 2. Fast path: verified & sole-loaded? → pass through（zero latency）
       ├─ 3. Target sole-loaded but cache expired? → skip load, ping to verify
       ├─ 4. Otherwise: unload other models（wait for completion）→ load（backoff retries）
       ├─ 5. Poll until the target instance appears
       ├─ 6. Ping readiness（max_tokens=1 chat completion）
       │      └─ on "Model is unloaded" → reload and re-verify
       └─ 7. Write verified cache → release request
```

All ensures for different models run through a **global serialized queue**, so concurrent requests never step on each other. Errors thrown inside the hook are `console.warn`-ed and rethrown → the request is aborted before HTTP dispatch (verified not to harm the plugin/server).

### 2. `retry` hook（synchronous recovery on provider failure）

```
provider request failed（attempt ≥ 2）
  └─ attempt > maxRecoveryAttempts（default 2）？ → leave decision untouched, hand back to opencode
  └─ otherwise: invalidate verified cache → re-ensure synchronously（catalog → load → ping）
       ├─ recovered → override event.decision = { retry: true, delay: 0 }（immediate retry）
       └─ not recovered → leave decision untouched（opencode default backoff）
```

### 3. `ctx.event.subscribe`（server-wide event stream, reactive preload）

```
session.execution.failed（data.error message contains "Model is unloaded"）
  └─ invalidate that session model's verified cache
     └─ background re-ensure after 250ms（same serialized queue）
        └─ the user's next retry goes through the fast path and succeeds

session.deleted（data.sessionID）
  └─ clear session→model record
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Log: `Plugin must export a default definition with an id and an effect or setup function` | `default` is not a plain `{ id, setup }` object (V1 function form). Upgrade to this version (v3.0.0) |
| Log: `configured plugin path must be a directory` | The config `plugins` `package` points at a `.js` file. Use the directory form (see “Method 2”) |
| Log: `Cannot find package '@opencode/plugin'` | The file uses the unsupported `import { Plugin }`. This plugin does not depend on that package; do not modify its import |
| Request fails: `{"message":"Model is unloaded."}` | Known issue of the old plugin; **upgrade to v3.0.0**. If it still happens the engine really failed to load (e.g. out of memory); check `[lmstudio]` messages on the server stdout |
| `[lmstudio] ... 逾時未就緒` / `not ready after timeout` | The engine loaded but can't infer (possibly out of memory). Use a smaller model or lower LM Studio's model loading guardrails |
| Load failure: `LM Studio 載入失敗: ...` | The model was rejected by LM Studio (possibly out of memory). Use a smaller model or lower guardrails |
| Model does not auto-switch | 1) confirm the file is in a `plugins/` directory (plural) or a config `plugins` directory entry 2) restart opencode 3) confirm `providerID` is `lmstudio` 4) grep for `loading plugin` as above |
| Want manual control back | Remove `plugins/lmstudio-model-loader.js` (or the config `plugins` entry + directory) and restart opencode |

### Uninstall

```bash
rm ~/.config/opencode/plugins/lmstudio-model-loader.js   # or the whole lmstudio-model-loader/ directory
# If you used Method 2, also remove the matching entry from the plugins array in opencode.json
```

---

## Tests & build

```bash
git clone https://github.com/wclinRD/opencode_lmstudio_loader.git
cd opencode_lmstudio_loader

# Unit tests (16, injected fake server + fake V2 ctx, no LM Studio needed)
npm test

# Real LM Studio system tests (auto-SKIP when not running)
npm run test:live

# Full build (syntax check + tests + copy to release/)
./build_release.sh
```

> The system test only runs a readiness ping against the single currently-loaded LLM; it never unloads or loads large models.