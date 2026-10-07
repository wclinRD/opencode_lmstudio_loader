# todo — lmstudio-model-loader 支援 OpenCode 2.0

> 調研完成日：2026-10-07
> 環境：本機 opencode **v2.0.20**（plugin 現行實作是 V1 API，README 記載以 1.18.20 驗證）

## 調研結論（詳見對話分析）

- V2 plugin loader 要求 `export default` 是 `{ id, setup|effect }` 物件 → 現有 V1 function export **會直接載入失敗**
- V1 → V2 對應：
  - `chat.params` → `ctx.session.hook("context")`（僅 agent loop）或 `ctx.session.hook("model.request")`（單一註冊涵蓋 primary/compaction/title/generate，型別待實測）
  - `event` → `ctx.event.subscribe()`（搭配 AbortController）
  - `dispose()` → `setup()` 回傳的 cleanup function
  - options 參數 → `ctx.options`
  - `provider.options.apiKey` → `ctx.provider.get({providerID}).settings` 或 `ctx.options.apiKey`
- 事件 payload 形狀：V1 `event.properties.*` → V2 很可能是 `event.data.*`（binary 內 schema 已確認 `session.error` / `session.deleted` 仍存在）→ 需實測，處理端雙相容
- 設定檔：`plugin` tuple → `plugins: [{ package, options }]`；`provider.npm/options` → `providers.package("aisdk:…")/settings`（V1 鍵 V2 仍會正規化，但 README 建議改原生 V2）
- 安裝路徑 `~/.config/opencode/plugins/` 與 `.opencode/plugins/` 在 V2 仍自動探索

## 待辦任務

- [x] **T0 決策**：✅ 已決定 **V2-only 單檔**（使用者 2026-10-07 選擇），不再相容 V1
- [x] T1 實測驗證：✅ 完成，詳見 `.probe/FINDINGS.md`。重點：
  - `export default` 純物件 `{ id, setup }` 可載入；`import { Plugin } from "@opencode/plugin"` **解析失敗**（不可用）
  - `chat.params` → `ctx.session.hook("model.request", cb, { providerID })`：event 有 `sessionID / model{id,providerID,variant} / kind(primary|title|generate|compaction) / agent / baseURL / headers`，async 有被 await，**throw 會中止請求**（HTTP 派發前）
  - `event` → `ctx.event.subscribe({ signal })` async iterable；envelope `[id, created, type, durable?, location?, data]`，payload 在 **`event.data.*`**
  - **V2 沒有 `session.error`** → 對應事件是 `session.execution.failed`（`data.error = {type, message}`）；`session.deleted` → `data.sessionID`
  - `ctx.provider.get({providerID})` → `{ location, data: { id, name, activation, package, settings: { apiKey, baseURL, ... } } }`（settings 在 `data.*`，baseURL 含 `/v1`）
  - `ctx.options` 取 plugin options；`setup()` 回傳 cleanup function
  - throw 錯誤處理策略：保留 V1 行為（catch → console.warn → rethrow），已驗證不傷害 plugin/server
  - 設定檔 `plugins` 陣列指向**檔案**在 2.0.20 被拒（`configured plugin path must be a directory`）；`.opencode/plugins/*.js` 自動探索檔案可用
- [x] T1 實測驗證（結果見 `.probe/FINDINGS.md`、`.probe/probe-log.txt`）：
  - `model.request` event keys = `[sessionID, agent, model{id,providerID,variant}, kind, baseURL, headers]`，無 `options/properties/data`；async callback 會被 await（1.5s sleep 實測延後 HTTP 派發）
  - `context` 只在 primary 觸發（keys 有 system/messages/options/agent/tools，無 kind/headers/baseURL）；`title`/`generate` 不觸發 context → 確認 `model.request` 為單一覆蓋全部請求型別的正確選擇
  - 事件 envelope = `{id, created, type, durable?, location?, data}`；payload **全在 `event.data.*`**（V1 `properties` 形狀已不存在）
  - **V2 無 `session.error`** → 改用 `session.execution.failed`（`data.error={type,message}`）；`session.deleted` → `data.sessionID`；另有 `session.step.failed`/`session.tool.failed`/`session.retry.scheduled`
  - `ctx.provider.get({providerID})` → `{location, data:{id,name,activation,package,settings}}`，`settings={apiKey, baseURL, provider}`
  - `import { Plugin } from "@opencode/plugin"` 解析失敗（裝了套件也一樣）→ 必須用純物件 `export default { id, setup }`
  - `ctx.session.remove()` 文件有、實作沒有；`ctx.event.subscribe` 是 server 全域事件流
- [x] T2 改寫 plugin 主程式為 V2：✅ 完成（940 行；純物件 `export default { id, setup }`、`model.request`/`retry` hook scoped、`event.subscribe` 處理 `session.execution.failed` + `session.deleted`、setup 回傳 cleanup、`ctx.options`、provider settings、`node --check` 通過）
- [x] T3 改寫測試 harness：✅ 完成（fake V2 ctx + 事件匯流排；`node --test tests/` → **16/16 通過**，含新增 retry hook / session.deleted / hook scope 測試；live.test.mjs 同步改寫）
- [x] T4 更新 README：✅ 完成（V2 格式要求、自動探索雙路徑已實測、目錄形式 plugins + 選項表、V2 provider 形狀、model.request/retry/event 運作原理、疑難排解）
- [x] T5 更新 build_release.sh + package.json → **v3.0.0**：✅ 完成（部署說明改為自動探索/目錄形式兩種）
- [x] T6 impl-validator 驗證 + build + 真機實測：✅ 完成
  - impl-validator：**WARN**（唯一 FAIL 為既有全域設定，非移植產物）→ 已依使用者決定修復
  - `./build_release.sh` 通過（16 單元 + 1 真機系統測試、release/ v3.0.0，舊檔已清）
  - 真機 mock e2e（opencode 2.0.20）：目錄形式載入 + options 傳遞、model.request（primary/title）、**retry hook decision delay 1605→0 覆寫**、失敗復原 → execution.succeeded
  - 真機 LM Studio e2e：ensure（catalog/load/ping 336ms）→ 真實推論 → succeeded；全域 `~/.config/opencode/plugins/` 自動探索已實測
  - 全域 `opencode.json` 壞條目已移除（備份 `opencode.json.bak-20261008`），改以自動探索安裝 `~/.config/opencode/plugins/lmstudio-model-loader.js`
- [x] T7 git init / commit：✅ 完成（`.gitignore` + 首次 commit；`.probe/` 探測目錄與 mock server 已清理）

## 二次 Review（2026-10-08）— 待處理問題清單

> 狀態：測試 16/16 pass + 1 skip、release/ 與原始碼一致、全域安裝一致、git clean。
> 以下為本輪 Review 發現的問題，依嚴重度分級。

### 中等（建議處理）— ✅ 2026-10-08 全數完成（v3.1.0）

- [x] M1 ✅ `retry` hook 新增 `isRecoverableModelError`：只對 unloaded/未就緒類錯誤復原，其餘錯誤不動 decision；decision 覆寫改 spread 保留既有欄位
- [x] M2 ✅ `chatPing` 附 `err.status`，新增 `isPermanentPingError`：4xx（非 408/429）/not found/invalid 類 ping 錯誤立即 fail fast
- [x] M3 ✅ 新選項 `recoveryEnsureTimeoutMs`（預設 15000）：retry hook 內 Promise.race 競速 + clearTimeout，逾時不動 decision、背景 ensure 繼續
- [x] M4 ✅ unload 逾時改 throw fail fast（含 instance ids 與調大提示），不再硬著頭皮 load
- [x] M5 ✅ 新增 11 個測試（16→27），含 M1 負向、M2 fail fast、M3 逾時、M4 卡住、alwaysSingleModel:false、cleanup()、catalog fail-fast/離線、Bearer header、baseURL 正規化、sessionModels 淘汰
- 驗證：impl-validator **PASS 14/14**；`./build_release.sh` 通過（27 單元 + live skip、release v3.1.0）
- 註：README 測試數已定稿 27/27；待辦剩 L1–L8、S1–S2

### 低（文件/一致性）

- [ ] L1 兩份 README 寫「LRU 淘汰」，實為 FIFO（Map 既有 key 重新 set 不更新順序）
- [ ] L2 「零延遲直通」誇大：快路徑仍會 GET /api/v1/models（本地、低成本，但不是零）
- [ ] L3 README 檔案結構未列 `release/`、`todo.md`、`.gitignore`（release/ 有提交到 git）
- [ ] L4 `VERSION.txt` 含 timestamp → 每次 build 弄髒 working tree（考慮 release/ 加 .gitignore 或去掉 timestamp）
- [ ] L5 `event.decision = {retry:true, delay:0}` 整物件覆寫，未來 V2 decision 若有其他欄位會被丟掉
- [ ] L6 verified cache 只以 fullKey 為 key，未含 baseURL（hook 動態改 baseURL 後的邊緣情況）
- [ ] L7 `cleanup()` 不中止/等待進行中的 ensure（背景 fetch 會跑完）
- [ ] L8 `lmstudio-model-loader.js` 檔案權限為 executable（非必要）

### 建議（repo 卫生）

- [ ] S1 公開到 GitHub 但無 LICENSE
- [ ] S2 無 CI（GitHub Actions 跑 `npm test`）
