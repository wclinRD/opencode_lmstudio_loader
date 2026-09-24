# LM Studio Model Loader Plugin（opencode）

確保 [opencode](https://opencode.ai) 每次對 LM Studio 發出 LLM 請求前，目標模型**已載入且引擎真的可以推論**、系統只保留單一模型，並能應對 LM Studio 的 Idle TTL / Auto-Evict / 引擎載入後死亡等狀態變化。

## 特性

- **請求前就緒保證**：透過 `chat.params` hook 攔截請求，在回傳前確保目標模型已載入並可推論；若引擎未就緒會等它 ready 才放行，解決 `{"message":"Model is unloaded."}` 問題。
- **單一模型管理**：載入新模型前自動卸載所有現有模型（`alwaysSingleModel`），避免多個模型同時佔用 LLM 記憶體。
- **並發競態防護**：全域序列化 queue + 同模型 in-flight 合併，避免不同模型同時載入時互相卸載（開新 session 時主模型 / small_model / subagent 同時發請求的主要競態）。
- **真正可推論驗證**：load 後 poll `loaded_instances`，並用最小 chat completion（`max_tokens=1`）ping 引擎直到可推論；若 ping 偵測到引擎死在 load 之後，會自動重新載入。
- **verified cache**：穩定狀態下直接直通（零額外延遲），快取含 instanceId + TTL，引擎替換後自動失效。
- **自動回復**：`event` hook 監聽 `session.error`，偵測到 "Model is unloaded" 立即失效快取並**背景預載**，使用者重送的下一發請求直接成功。
- **context_length 支援**：載入模型時同步 `limit.context`（即 opencode.jsonc 的模型設定），LM Studio 不再以模型預設最大值載入。
- **可注入 fetch**：`fetchImpl` 可注入（供測試使用），預設 `globalThis.fetch`。

## 運作原理

```
使用者發送 LLM 請求
        │
        ▼
chat.params hook 攔截
  ① 過濾：僅處理 providerID === "lmstudio" 的請求
  ② 解析完整模型 key（若模型未載入 → 觸發載入流程）
  ③ 記錄 context_length 與 session → model 對應
  ④ 快路徑：verified cache 命中且無衝突 → 直接放行（零延遲）
  ⑤ 否則序列化 ensure：
       unload（卸載其他模型）→ load → poll 執行實體 → ping 可推論
       三處 load 皆帶 context_length（模型在設定中的 limit.context）
       全部就緒後才回傳請求
        │
        ▼
原始請求放行 → LLM 請求直接成功
```

引擎因 Idle TTL / Auto-Evict / 崩潰而卸載時：

```
session.error（"Model is unloaded"）
        │
        ▼
event hook 偵測 → 失效 verified cache → 背景預載（沿用 context_length）
        │
        ▼
使用者重送請求 → 直接命中快路徑，成功
```

## 安裝

將 `plugins/lmstudio-model-loader.js` 複製到 opencode 的 plugins 目錄（未存在則建立）：

```bash
mkdir -p ~/.config/opencode/plugins
cp plugins/lmstudio-model-loader.js ~/.config/opencode/plugins/
```

opencode 啟動時會自動載入 `~/.config/opencode/plugins/` 下的 plugin，無需其他設定。

## 設定

plugin 處理 `providerID === "lmstudio"` 的請求，並以 `chat.params` 傳入的模型設定為準。在 `opencode.jsonc` 的 `provider` 中加入 LM Studio：

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

### context_length 的決定順序

| 優先序 | 來源 | 說明 |
|---|---|---|
| 1 | `models.<id>.limit.context` | opencode.jsonc 的模型設定（如上例 145328），**動態讀取**，每次請求都會重新取得 |
| 2 | plugin 選項 `contextLength` | fallback，當模型未設定 `limit` 時使用 |
| — | 兩者皆無 | 不送出 `context_length`，由 LM Studio 依模型預設值載入 |

只需修改 `opencode.jsonc` 的 `limit.context` 數字即可調整載入 context，不必改 plugin。

## Plugin 選項

以程式方式載入 plugin 時（例如在 opencode 的設定中註冊），可傳入以下選項：

| 選項 | 預設值 | 說明 |
|---|---|---|
| `baseURL` | `http://127.0.0.1:1234` | LM Studio API 基礎 URL（自動正規化，可帶 `/v1`） |
| `providerID` | `"lmstudio"` | 欲處理的 provider ID |
| `alwaysSingleModel` | `true` | 載入新模型前卸載所有現有模型 |
| `fetchImpl` | `globalThis.fetch` | fetch 實作（可注入供測試） |
| `loadTimeoutMs` | `300000` | load 後 catalog poll 上限 |
| `readyTimeoutMs` | `300000` | ping 就緒驗證上限 |
| `unloadCompletionTimeoutMs` | `15000` | unload 完成 poll 上限 |
| `maxLoadRetries` | `3` | load 重試次數（transient 錯誤退避） |
| `loadRetryBaseDelayMs` | `1500` | load 重試退避基準 |
| `readyTTLMs` | `90000` | verified cache 有效期間 |
| `pingEnabled` | `true` | 是否啟用 ping 就緒驗證 |
| `pingMaxTokens` | `1` | ping 用的 `max_tokens` |
| `pollIntervalMs` | `1000` | catalog poll 間隔 |
| `pingRetryDelayMs` | `1500` | ping 失敗重試間隔 |
| `nudgePollTimeoutMs` | `15000` | 偵測到 unloaded 後重新載入的 poll 上限 |
| `fetchTimeoutMs` | `10000` | 一般 fetch 逾時（fetchModels / unloadInstance / chatPing） |
| `loadFetchTimeoutMs` | `30000` | load 請求的 fetch 逾時 |
| `maxSessionModels` | `500` | session→model 記錄上限（超過刪除最舊） |
| `apiKey` | `undefined` | LM Studio API token（也可由 `chat.params` 的 provider options 動態取得） |
| `contextLength` | `undefined` | 載入時的 `context_length` fallback（主要來源是模型設定的 `limit.context`） |

## 測試

專案內建單元測試與系統測試（無需真實 LM Studio，使用可注入的 mock fetch）：

```bash
# 單元測試（純函式）
node --test tests/lmstudio-model-loader/unit.test.mjs

# 系統測試（完整 hooks 流程 + mock fetch）
node --test tests/lmstudio-model-loader/system.test.mjs

# 全部
node --test tests/lmstudio-model-loader/
```

## Build / Release

`build_release_lmstudio.sh` 會依序執行單元測試 → 系統測試 → 建立 `release/` 資料夾（不存在時自動建立）並複製 plugin 與測試：

```bash
./build_release_lmstudio.sh
```

## 目錄結構

```
.
├── plugins/
│   └── lmstudio-model-loader.js     # plugin 本體（唯一 export 為 default）
├── tests/
│   └── lmstudio-model-loader/
│       ├── helpers.mjs              # 從原始碼提取純函式的測試輔助
│       ├── unit.test.mjs            # 單元測試（純函式）
│       └── system.test.mjs          # 系統測試（hooks + mock fetch）
├── build_release_lmstudio.sh        # build / release 腳本
└── release/                         # build 產物（由腳本自動建立）
```

> ⚠️ 注意：plugin 檔案**只能有一個 export（`export default`）**。opencode 的 plugin loader 會迭代 module 的所有 exports 並逐一當作 plugin 執行；若有其他具名 export 會被誤當 plugin 呼叫而導致載入失敗。所有 helper 都是 module 內部的函式。