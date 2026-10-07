# LM Studio Model Loader Plugin（lmstudio-model-loader）

讓 opencode 在使用 LM Studio 模型（`lmstudio/*`）時，**自動卸載舊模型、載入目標模型**，保證記憶體只保留單一模型，並確保「請求送出前模型引擎真的可以推論」。

> 本 plugin 為 **opencode V2 plugin API** 版本，已在本機實測通過（2026-10-08）：
> - **opencode 2.0.20 + 真實 LM Studio**：冷啟動 ensure（catalog → load → poll → ping）→ 真實推論成功
> - **opencode 2.0.20 + mock server**：`model.request` hook（primary/title）、`retry` hook（decision 覆寫 delay 1605→0）、事件訂閱、失敗復原 → `session.execution.succeeded`
> - 單元測試 16/16 通過（`node --test`）

---

## 功能特性

| 功能 | 說明 |
|---|---|
| 自動載入 | 每次 LLM 請求前（`model.request` hook），若目標模型未載入 → 自動載入 |
| 自動卸載 | `alwaysSingleModel`（預設 `true`）：載入新模型前先卸載所有已載入模型 |
| **就緒驗證（ping）** | load 後用最小 chat completion（`max_tokens=1`）確認引擎真的可推論，才放行請求 |
| **並發序列化** | 不同模型的並發載入**排隊執行**，避免 A 剛載入就被 B 卸載（修復 `Model is unloaded` 主因） |
| **快路徑 + 快取** | 已驗證且唯一載入 → 零延遲直通（verified cache 含 instanceId + TTL） |
| **回應式預載** | 訂閱 `session.execution.failed`，偵測 `Model is unloaded` → 失效快取並背景預載，重送即成功 |
| **失敗自動復原** | `retry` hook：provider 請求失敗時同步重新 ensure，成功則覆寫 `decision = {retry:true, delay:0}` 立即重試 |
| **卸載完成等待** | unload 是 async，會 poll 到 instance 真正消失才載入新模型 |
| **load 重試** | transient 錯誤（503/429/network/busy…）退避重試；硬失敗（404 not found）不重試 |
| Provider 過濾 | 非 `lmstudio` provider 的請求完全不干擾（hook 以 `{ providerID }` scope 註冊） |

## 檔案結構

```
lmstudio_auto_switch/
├── lmstudio-model-loader.js   # Plugin 主程式（單一檔案、僅 export default）
├── package.json               # 測試用（type: module）
├── build_release.sh           # 建置腳本（語法檢查 + 測試 + 複製到 release/）
├── tests/
│   ├── lmstudio-model-loader.test.mjs  # 功能測試（注入式 fake server，不需 LM Studio）
│   └── live.test.mjs                   # 系統測試（真實 LM Studio，未啟動會 SKIP）
└── README.md                  # 本文件
```

> ⚠️ **V2 plugin 格式要求**
> opencode 2.x 的 plugin loader 要求 module 的 `export default` 是 **`{ id, setup }` 純物件**：
> ```js
> export default {
>   id: "lmstudio-model-loader",
>   async setup(ctx) { /* ... */ return cleanup; },
> };
> ```
> - `import { Plugin } from "@opencode/plugin"` 在 2.0.20 **無法解析**（即使安裝套件），請勿使用
> - 若 default export 不是合法物件，日誌會出現
>   `Plugin must export a default definition with an id and an effect or setup function`
> - 檔案保持**單一 default export**，其他輔助函式不對外 export

---

## 前置需求

- **opencode ≥ 2.0**（V2 plugin API；本檔以 2.0.20 驗證。V1 的 opencode 1.x **不相容**本版）
- **LM Studio** 正在執行，且 API server 開啟（預設 `http://127.0.0.1:1234`）
- opencode 設定檔中已有 `lmstudio` provider（見下方「設定 opencode 設定檔」）

---

## 安裝

### 方式一：自動探索（最簡單，使用預設選項）

把 `lmstudio-model-loader.js` 複製到 opencode 的 plugin 目錄。**注意是 `plugins/`（複數）**：

```bash
# 全域安裝（所有專案共用）— 已於 2.0.20 實測
cp lmstudio-model-loader.js ~/.config/opencode/plugins/

# 或 專案限定（僅目前專案，放在專案根目錄）— 已於 2.0.20 實測
mkdir -p .opencode/plugins
cp lmstudio-model-loader.js .opencode/plugins/
```

**重啟 opencode** 即完成。

### 方式二：自訂選項（設定檔 `plugins`，**必須是目錄**）

opencode 2.0.20 起，設定檔 `plugins` 陣列的 `package` **只接受目錄路徑**（指向 `.js` 檔會被拒，
日誌出現 `configured plugin path must be a directory`）。自訂選項的作法：

```bash
# 1. 建立目錄，把 plugin 檔放成目錄內的 index.js，並附 package.json
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
// 2. opencode.json 指向該目錄，options 即 ctx.options
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

> 提醒：
> - `plugins`（複數、物件陣列）是 **V2 格式**；V1 的 `plugin`（單數、`[路徑, 選項]` tuple）已不適用
> - 若同一份 plugin 又放在 `plugins/` 目錄被自動探索，會載入兩份；自訂選項時**不要**重複放置

### 選項一覽（ctx.options）

| 選項 | 預設值 | 說明 |
|---|---|---|
| `baseURL` | `http://127.0.0.1:1234` | LM Studio API 位址（未顯式設定時，會取 provider settings 的 baseURL 並去掉 `/v1`） |
| `providerID` | `lmstudio` | 要攔截的 provider 名稱 |
| `alwaysSingleModel` | `true` | 載入新模型前卸載全部舊模型 |
| `loadTimeoutMs` | `300000` | load 後 catalog poll 上限 |
| `readyTimeoutMs` | `300000` | ping 就緒驗證上限 |
| `unloadCompletionTimeoutMs` | `15000` | unload 完成 poll 上限 |
| `maxLoadRetries` | `3` | load 重試次數 |
| `loadRetryBaseDelayMs` | `1500` | load 重試退避基準 |
| `readyTTLMs` | `90000` | verified cache 有效期間 |
| `pingEnabled` | `true` | 是否啟用 ping 就緒驗證 |
| `pingMaxTokens` | `1` | ping 用的 max_tokens |
| `pingRetryDelayMs` | `1500` | ping 失敗重試間隔 |
| `pollIntervalMs` | `1000` | catalog / unload 完成 poll 間隔 |
| `nudgePollTimeoutMs` | `15000` | 偵測到 unloaded 後 nudge reload 的 poll 上限 |
| `fetchTimeoutMs` | `10000` | 一般 API 請求逾時 |
| `loadFetchTimeoutMs` | `30000` | load/unload API 請求逾時 |
| `maxSessionModels` | `500` | session→model 記錄上限（LRU 淘汰） |
| `maxRecoveryAttempts` | `2` | `retry` hook 復原上限（attempt 從 2 開始） |
| `apiKey` | 無 | LM Studio API key（通常不需） |

---

## 設定 opencode 設定檔（lmstudio provider）

`opencode.json`（位於 `~/.config/opencode/opencode.json` 或專案 `.opencode/`）需有 `lmstudio` provider 與模型定義，plugin 才能攔截到請求。以下為 **V2 形狀**（`providers` 複數 + `package` + `settings`，以 2.0.20 驗證）：

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

> 模型 key 建議使用 LMS 模型庫中的**完整 key**（含 publisher 前綴，如 `qwen/qwen3.8-27b`）。
> 可用以下指令查詢完整 key：
> ```bash
> curl -s http://127.0.0.1:1234/api/v1/models | jq -r '.models[].key'
> ```

---

## 使用方式

1. 重啟 opencode（讓 plugin 載入並註冊 hook）。
2. 在 opencode 內用 `/model` 切換到任何 `lmstudio/*` 模型。
3. **不需要任何手動操作** — 每次請求送出前，plugin 會自動：檢查目前載入 → 不同就卸載 → 載入目標模型 → **ping 確認引擎就緒** → 才放行請求。

### 驗證 plugin 已正常載入

```bash
# 應看到 loading plugin ... lmstudio-model-loader（或其目錄）
grep -F "loading plugin" ~/.local/share/opencode/log/opencode.log | tail

# 不應有 plugin 載入失敗訊息
grep -F "failed to load plugin" ~/.local/share/opencode/log/opencode.log | tail
# （若曾用 V1 設定檔格式，另需確認無 "configured plugin path must be a directory"）
```

確認目前 LMS 已自動載入對應模型：

```bash
curl -s http://127.0.0.1:1234/api/v1/models \
  | jq -r '.models[] | select((.loaded_instances // []) | length > 0) | .key'
```

> Plugin 的 `[lmstudio]` console 訊息輸出到 opencode server process 的 stdout
> （`opencode serve` 的終端機畫面；`opencode run --standalone` 下不會出現在 opencode.log）。

---

## 運作原理

Plugin 的 `setup(ctx)` 註冊三個機制，回傳 cleanup function（unload 時執行）：

### 1. `model.request` hook（請求送出前，保證就緒；scope `{ providerID: "lmstudio" }`）

涵蓋 `kind = primary / title / compaction / generate` 全部請求型別（V1 `chat.params` 的對應）：

```
請求送出
  └─ model.request hook（僅攔截 providerID = "lmstudio" 的請求）
       ├─ 1. 查詢目前 LMS 已載入模型（GET /api/v1/models）
       ├─ 2. 快路徑：已驗證且唯一載入？ → 直接放行（零延遲）
       ├─ 3. 目標已是唯一載入但快取過期？ → 跳過 load，直接 ping 驗證
       ├─ 4. 否則：卸載其他模型（等卸載完成）→ load（失敗退避重試）
       ├─ 5. poll 直到目標 instance 出現
       ├─ 6. ping 就緒驗證（max_tokens=1 chat completion）
       │      └─ 偵測到 "Model is unloaded" → 重新載入再驗
       └─ 7. 寫入 verified cache → 放行請求
```

所有不同模型的 ensure 都透過**全域序列化 queue** 依序執行，並發請求不會互踩。
hook 內拋出的錯誤會 `console.warn` 後 rethrow → 該次請求在 HTTP 派發前中止（已實測不傷害 plugin/server）。

### 2. `retry` hook（provider 請求失敗時，同步復原）

```
provider 請求失敗（attempt ≥ 2）
  └─ attempt > maxRecoveryAttempts（預設 2）？ → 不動 decision，交還 opencode
  └─ 否則：失效 verified cache → 同步重新 ensure（catalog → load → ping）
       ├─ 復原成功 → 覆寫 event.decision = { retry: true, delay: 0 }（立即重試）
       └─ 復原失敗 → 不動 decision（沿用 opencode 預設退避）
```

### 3. `ctx.event.subscribe`（server 全域事件流，回應式預載）

```
session.execution.failed（data.error 訊息含 "Model is unloaded"）
  └─ 失效該 session 模型的 verified cache
     └─ 250ms 後背景重新 ensure（走同一序列化 queue）
        └─ 使用者重送的下一發請求直接走快路徑成功

session.deleted（data.sessionID）
  └─ 清除 session→model 記錄
```

---

## 疑難排解

| 問題 | 處理方式 |
|---|---|
| 日誌出現 `Plugin must export a default definition with an id and an effect or setup function` | default export 不是 `{ id, setup }` 純物件（V1 function 形式）。更新到本版（v3.0.0） |
| 日誌出現 `configured plugin path must be a directory` | 設定檔 `plugins` 的 `package` 指到 `.js` 檔。改為目錄形式（見「方式二」） |
| 日誌出現 `Cannot find package '@opencode/plugin'` | 檔案用了 V1/未支援的 `import { Plugin }`。本 plugin 不依賴該套件，請勿修改 import |
| 請求失敗：`{"message":"Model is unloaded."}` | 舊版 plugin 的已知問題，**更新到 v3.0.0**。若仍發生，代表引擎真的載入失敗（如記憶體不足），看 server stdout 的 `[lmstudio]` 訊息 |
| 日誌/畫面出現 `[lmstudio] ... 逾時未就緒` | 模型載入後引擎一直無法推論（可能記憶體不足）。改用較小模型，或降低 LMS 的 model loading guardrails |
| 載入失敗：`LM Studio 載入失敗: ...` | 模型可能因記憶體不足被 LMS 拒絕。改用較小模型，或降低 LMS 的 model loading guardrails |
| 模型沒有自動切換 | 1) 確認檔案位於 `plugins/`（複數）目錄或設定檔 `plugins` 目錄條目 2) 重啟 opencode 3) 確認 config 的 providerID 是 `lmstudio` 4) 用上方 grep 確認有 `loading plugin` |
| 想換回手動管理 | 移除 `plugins/lmstudio-model-loader.js`（或設定檔 `plugins` 條目 + 目錄）並重啟 opencode |

### 卸載

```bash
rm ~/.config/opencode/plugins/lmstudio-model-loader.js   # 或整個 lmstudio-model-loader/ 目錄
# 若用方式二，也記得刪除 opencode.json 中 plugins 陣列的對應條目
```

---

## 測試與建置

```bash
cd ~/openchamber/lmstudio_auto_switch

# 功能測試（16 項，注入式 fake server + fake V2 ctx，不需 LM Studio）
npm test

# 真實 LM Studio 系統測試（未啟動會自動 SKIP）
npm run test:live

# 完整建置（語法檢查 + 測試 + 複製到 release/）
./build_release.sh
```

> 系統測試只會對「目前唯一已載入的 LLM」做就緒 ping 驗證，**不會**卸載或載入大型模型。
