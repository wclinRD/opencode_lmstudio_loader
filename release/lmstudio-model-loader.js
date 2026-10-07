/**
 * LM Studio Model Loader Plugin
 *
 * 確保 LM Studio 每次 LLM 請求前，目標模型已載入「且引擎真的可以推論」、
 * 系統只保留一個模型，並能應對 LM Studio 的 Idle TTL / Auto-Evict / 引擎
 * 載入後死亡等狀態變化。
 *
 * 透過 opencode V2 的 scoped `model.request` hook 攔截請求，在回傳前保證
 * 目標模型就緒；並透過 scoped `retry` hook 與 `ctx.event.subscribe` 監聽
 * `session.execution.failed`，偵測 "Model is unloaded" 後立即失效快取並
 * 背景預載，讓使用者重送的下一發請求直接成功。
 *
 * 修正紀錄（對應 {"message":"Model is unloaded."} 問題）：
 * 1. 全域序列化 queue：不同 model 的並發載入排隊執行，避免 A 剛載入完成就被
 *    B 的 unload-all 卸載（重開 session 時主 model / small_model / subagent
 *    同時發請求的主要競態）。
 * 2. 就緒驗證：load 後 poll loaded_instances，並用最小 chat completion
 *    (max_tokens=1) ping 引擎，直到真正可推論；ping 偵測到 "Model is unloaded"
 *    代表引擎死在 load 之後，會重新載入。
 * 3. verified cache（含 instanceId + TTL）：穩定狀態下直接直通，零額外延遲。
 * 4. unload 後 poll 卸載完成、load transient 錯誤退避重試。
 * 5. fetchImpl 可注入（供測試使用），預設 globalThis.fetch。
 *
 * ⚠️ 重要：本檔「只能」有一個 export，且必須是 V2 物件形式：
 * `export default { id: "...", async setup(ctx) { ... } }`。
 * V2 無 hooks 物件、不可 `import { Plugin } from "@opencode/plugin"`（實測
 * 解析失敗）；具名 export 亦不可有，所有 helper 都必須是 module 內部函數。
 */

// ─── 核心函數（module 內部，不 export）────────────────────────

/**
 * 帶 timeout 的 fetch wrapper。
 *
 * 所有 LM Studio API 呼叫都透過此函式，避免 LM Studio 接受連線但不回應時
 * 永久卡住序列化 queue（AbortController 會在 timeoutMs 後中止請求）。
 *
 * @param {Function} fetchImpl - fetch 實作
 * @param {string} url - 請求 URL
 * @param {object} [init] - fetch init 選項
 * @param {number} timeoutMs - 逾時毫秒數
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 依 apiKey 產生 Authorization header（LM Studio v1 API 支援 Bearer token）。
 *
 * @param {string|undefined} apiKey - API token
 * @returns {object|undefined} headers 物件（無 apiKey 時回傳 undefined）
 */
function apiHeaders(apiKey) {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
}

/**
 * 取得 LM Studio 模型庫清單（GET /api/v1/models 的 models 陣列）。
 *
 * 失敗時回傳 []，由呼叫端自行容錯（resolveKeyFromCatalog 會退回原 id）。
 *
 * @param {string} baseURL - LM Studio API 基礎 URL
 * @param {Function} fetchImpl - fetch 實作（預設 globalThis.fetch）
 * @param {{apiKey?: string, fetchTimeoutMs?: number}} [opts] - 請求選項
 * @returns {Promise<Array<object>>} models 陣列（失敗時回傳 []）
 */
async function fetchModels(baseURL, fetchImpl, opts = {}) {
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${baseURL}/api/v1/models`,
      { headers: apiHeaders(opts.apiKey) },
      opts.fetchTimeoutMs ?? 10000
    );
    if (!res.ok) {
      console.warn(`[lmstudio] 取得模型列表失敗 (HTTP ${res.status})`);
      return [];
    }
    const data = await res.json();
    return data.models ?? [];
  } catch (err) {
    console.warn(`[lmstudio] 取得模型列表發生異常:`, err);
    return [];
  }
}

/**
 * 從模型庫清單萃取出所有已載入的模型執行實體。
 *
 * modelKey 的取得優先順序：
 * 1. `loaded_instances[].model`（相容舊格式）
 * 2. `loaded_instances[].config?.model`（相容舊格式）
 * 3. `models[].key`（LM Studio 真實格式）
 * 4. `models[].display_name`（fallback）
 * 5. `"unknown"`
 *
 * @param {Array<object>} models - fetchModels 回傳的模型庫清單
 * @returns {Array<{instanceId: string, modelKey: string, fullKey: string}>}
 */
function listLoadedFromModels(models) {
  const instances = [];

  for (const model of models ?? []) {
    for (const inst of model.loaded_instances ?? []) {
      const key =
        inst.model ??
        inst.config?.model ??
        model.key ??
        model.display_name ??
        "unknown";
      if (inst.id) {
        instances.push({
          instanceId: inst.id,
          modelKey: key,
          fullKey: model.key ?? key,
        });
      }
    }
  }

  return instances;
}

/**
 * 將 opencode 傳入的 modelID（可能是短 id，如 `qwen3.6-35b-a3b`）
 * 解析為 LM Studio 的完整模型 key（如 `qwen/qwen3.6-35b-a3b`）。
 *
 * 匹配順序：
 * 1. `model.key` 精確等於 modelID
 * 2. `model.key` 在 `/` 之後的末段等於 modelID
 * 3. `model.display_name` 等於 modelID
 * 4. 都找不到 → 回傳原 modelID（讓 LM Studio 自行判斷）
 *
 * @param {Array<object>} models - fetchModels 回傳的模型庫清單
 * @param {string} targetId - 目標 modelID（opencode 傳入）
 * @returns {string} 完整模型 key（或原 modelID）
 */
function resolveKeyFromCatalog(models, targetId) {
  if (!targetId) return targetId;
  if (models.some((m) => m.key === targetId)) return targetId;
  const byTail = models.find((m) => (m.key ?? "").split("/").pop() === targetId);
  if (byTail) return byTail.key;
  const byName = models.find((m) => m.display_name === targetId);
  if (byName) return byName.key;
  return targetId;
}

/**
 * 卸載指定的模型執行實體。
 *
 * 呼叫 POST {baseURL}/api/v1/models/unload，body 為 `{ "instance_id": instanceId }`。
 * 失敗時僅記錄警告（console.warn），不會拋出錯誤。
 *
 * @param {string} baseURL - LM Studio API 基礎 URL
 * @param {string} instanceId - 要卸載的執行實體 ID
 * @param {Function} fetchImpl - fetch 實作
 * @param {{apiKey?: string, fetchTimeoutMs?: number}} [opts] - 請求選項
 * @returns {Promise<void>}
 */
async function unloadInstance(baseURL, instanceId, fetchImpl, opts = {}) {
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${baseURL}/api/v1/models/unload`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiHeaders(opts.apiKey) },
        body: JSON.stringify({ instance_id: instanceId }),
      },
      opts.fetchTimeoutMs ?? 10000
    );
    if (!res.ok) {
      console.warn(`[lmstudio] 卸載執行實體 ${instanceId} 失敗 (HTTP ${res.status})`);
    }
  } catch (err) {
    console.warn(`[lmstudio] 卸載執行實體 ${instanceId} 發生異常:`, err);
  }
}

/**
 * 載入指定的模型。
 *
 * 呼叫 POST {baseURL}/api/v1/models/load，body 為 `{ "model": modelKey }`。
 * 失敗時回傳 { ok:false, status, body }，不會拋出錯誤（由呼叫端決定重試）。
 *
 * @param {string} baseURL - LM Studio API 基礎 URL
 * @param {string} modelKey - 要載入的模型 key
 * @param {Function} fetchImpl - fetch 實作
 * @param {{apiKey?: string, loadFetchTimeoutMs?: number}} [opts] - 請求選項
 * @returns {Promise<{ok: boolean, status: number, body?: unknown}>}
 */
async function loadModel(baseURL, modelKey, fetchImpl, opts = {}) {
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${baseURL}/api/v1/models/load`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiHeaders(opts.apiKey) },
        body: JSON.stringify({ model: modelKey }),
      },
      opts.loadFetchTimeoutMs ?? 30000
    );

    let body;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }

    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: { error: { message: String(err), type: "network", code: 0 } },
    };
  }
}

/**
 * 解析 LM Studio HTTP 錯誤回應格式，回傳有意義的錯誤訊息。
 *
 * LM Studio 錯誤格式：{ error: { message, type, code } }
 * 若格式不符，回傳狀態碼描述。
 *
 * @param {{ok: boolean, status: number, body?: unknown}} res - loadModel 回傳
 * @returns {string}
 */
function httpErrorToString(res) {
  if (res.body && typeof res.body === "object" && "error" in res.body) {
    const err = res.body.error;
    if (err && typeof err === "object" && "message" in err) {
      const msg = err.message;
      const type = err.type;
      const code = err.code;
      const parts = [];
      if (msg) parts.push(msg);
      if (type) parts.push(`type: ${type}`);
      if (code != null) parts.push(`code: ${code}`);
      return parts.join(" | ");
    }
  }
  return `HTTP ${res.status}`;
}

/**
 * 最小就緒探測：對目標模型發送一個 max_tokens=1 的 chat completion。
 *
 * 只要 LM Studio 的引擎真的可以推論，這個請求就會成功；若引擎未就緒或已
 * 卸載，則 reject 並帶上 LM Studio 的錯誤訊息（如 "Model is unloaded."）。
 *
 * @param {string} baseURL - LM Studio API 基礎 URL（不含 /v1）
 * @param {string} fullKey - 完整模型 key
 * @param {Function} fetchImpl - fetch 實作
 * @param {{apiKey?: string, fetchTimeoutMs?: number, pingMaxTokens?: number}} [opts] - 請求選項
 * @returns {Promise<void>} ping 成功時 resolve
 */
async function chatPing(baseURL, fullKey, fetchImpl, opts = {}) {
  const res = await fetchWithTimeout(
    fetchImpl,
    `${baseURL}/v1/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...apiHeaders(opts.apiKey) },
      body: JSON.stringify({
        model: fullKey,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: opts.pingMaxTokens ?? 1,
        stream: false,
      }),
    },
    opts.fetchTimeoutMs ?? 10000
  );

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error?.message) msg = j.error.message;
    } catch {
      // 保留 HTTP 狀態碼描述
    }
    throw new Error(msg);
  }
}

/**
 * 檢查錯誤訊息是否為 LM Studio 的 "Model is unloaded"。
 *
 * @param {string} text - 錯誤文字
 * @returns {boolean}
 */
function isUnloadedMessage(text) {
  return /model is unloaded/i.test(String(text ?? ""));
}

/**
 * 判斷 load 回應是否屬於「值得重試」的 transient 錯誤。
 *
 * 重試：network(0)、5xx、408、429，或訊息含 busy / unload / failed to load /
 * timeout / not ready / loading。
 * 不重試：其餘 4xx（尤其 model not found 類）。
 *
 * @param {{ok: boolean, status: number, body?: unknown}} res - loadModel 回傳
 * @returns {boolean}
 */
function isRetryableLoadError(res) {
  if (res.ok) return false;
  const status = res.status;
  if (status === 0) return true; // network error
  if (status >= 500) return true;
  if (status === 408 || status === 429) return true;

  const msg = res.body && typeof res.body === "object" ? res.body.error?.message : undefined;
  if (typeof msg === "string") {
    if (/not found|no such model|does not exist|invalid/i.test(msg)) return false;
    if (/busy|unload|failed to load|timeout|not ready|loading/i.test(msg)) return true;
  }
  return false;
}

/**
 * 從任意錯誤結構（opencode event 的 error 物件）遞迴萃取出 message 字串。
 *
 * opencode 的錯誤可能包裝成 ApiError / UnknownError / NamedError 等不同結構，
 * 用深層搜尋找出人類可讀的錯誤訊息，避免 JSON 格式差異漏判。
 *
 * @param {unknown} obj - 錯誤物件
 * @returns {string} 找到的第一個訊息字串（找不到回傳 ""）
 */
function extractErrorMessage(obj) {
  if (obj == null) return "";
  if (typeof obj === "string") return obj;

  const seen = new Set();
  const stack = [obj];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur == null || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);

    // 1. SDK NamedError 結構：{ name, data: { message } } — data.message 優先，
    //    避免誤取 name（例如 "APIError"）當作實際訊息。
    const dataMsg =
      cur.data && typeof cur.data === "object" && typeof cur.data.message === "string" && cur.data.message.length > 0
        ? cur.data.message
        : "";
    if (dataMsg) return dataMsg;

    // 2. 原生 Error / { message } / { error: { message } }
    const direct =
      typeof cur.message === "string" && cur.message.length > 0
        ? cur.message
        : cur.error && typeof cur.error === "object" && typeof cur.error.message === "string"
          ? cur.error.message
          : "";
    if (direct) return direct;

    // 3. 遞迴探索子物件（不回傳任意字串值，避免 name 欄位誤判）
    for (const v of Object.values(cur)) {
      if (typeof v === "object" && v !== null) stack.push(v);
    }
  }
  return "";
}

/**
 * 延遲工具。
 *
 * @param {number} ms - 毫秒
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 正規化 LM Studio API 基礎 URL。
 *
 * opencode 的 provider 設定慣例是含 `/v1` 尾綴（OpenAI-compatible baseURL），
 * 但本 plugin 的 API 呼叫是 `{baseURL}/api/v1/models` 與 `{baseURL}/v1/chat/completions`，
 * 因此 baseURL 必須是 root。此函式移除尾綴 `/` 與 `/v1`，避免使用者照 provider
 * 設定填寫時產生 `.../v1/api/v1/models` 這類錯誤 URL。
 *
 * @param {string} url - 原始 baseURL
 * @returns {string} 正規化後的 baseURL
 */
function normalizeBaseURL(url) {
  if (!url) return url;
  return url.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/**
 * 快路徑檢查：目標模型「已驗證就緒」時直接放行。
 *
 * 條件全數成立才回傳 true：
 * 1. catalog 中目標 model 有 loaded instance
 * 2. `alwaysSingleModel` 時它必須是唯一載入的 instance（避免與其他模型並存時
 *    直接放行，導致 unload-all 語意被破壞）；`alwaysSingleModel: false` 時
 *    允許多模型並存，只要目標已載入即可
 * 3. verified cache 存在
 * 4. cache 的 instanceId 與目前 instance id 相同（未被替換/重載）
 * 5. cache 未超過 readyTTLMs
 *
 * @param {{verified: Map<string, {instanceId: string, ts: number}>}} state - plugin 狀態
 * @param {string} fullKey - 完整模型 key
 * @param {Array<{instanceId: string, modelKey: string}>} loaded - 已載入清單
 * @param {{readyTTLMs: number, alwaysSingleModel: boolean}} opts - plugin 選項
 * @returns {boolean}
 */
function isVerifiedFastPath(state, fullKey, loaded, opts) {
  const inst = loaded.find((i) => i.modelKey === fullKey);
  if (!inst) return false;
  if (opts.alwaysSingleModel && loaded.length !== 1) return false;

  const v = state.verified.get(fullKey);
  if (!v) return false;
  if (v.instanceId !== inst.instanceId) return false;
  if (Date.now() - v.ts >= opts.readyTTLMs) return false;
  return true;
}

/**
 * 檢查是否有模型衝突：其他 pending/in-flight 請求要載入不同模型。
 *
 * @param {{pending: Set, inFlight: Map}} state - plugin 狀態
 * @param {object} selfToken - 當前請求的 token 物件
 * @param {string} fullKey - 當前請求的目標模型 key
 * @returns {boolean}
 */
function hasModelConflict(state, selfToken, fullKey) {
  for (const p of state.pending ?? []) {
    if (p === selfToken) continue;
    if (p.full === null) return true; // 其他請求尚未解析 key，保守視為衝突
    if (p.full !== fullKey) return true; // 其他請求要不同的模型
  }
  for (const k of state.inFlight?.keys?.() ?? []) {
    if (k !== fullKey) return true; // 背景預載等 in-flight ensure 會卸載此模型
  }
  return false;
}

/**
 * 核心載入流程：確保目標模型真正就緒（可推論）後才回傳。
 *
 * 步驟：
 * 1. 快路徑：已驗證就緒 → 直接回傳。
 * 2. 目標已載入（無論是否唯一）→ 跳過 load，直接進入 ping 驗證。
 * 3. 否則：unload 其他模型（alwaysSingleModel）並等卸載完成。
 * 4. load（transient 錯誤退避重試）→ poll catalog 直到目標 instance 出現。
 * 5. ping 就緒驗證（embedding 模型跳過）；ping 偵測到 "Model is unloaded"
 *    代表引擎死在 load 之後 → 重新載入再驗。
 * 6. 寫入 verified cache。
 *
 * @param {{queue: Promise, inFlight: Map, verified: Map, sessionModels: Map, apiKey?: string}} state - plugin 狀態
 * @param {string} fullKey - 完整模型 key
 * @param {object} opts - plugin 選項
 * @returns {Promise<{fast: boolean}>}
 */
async function ensureLoaded(state, fullKey, opts) {
  const baseURL = opts.baseURL;
  const fetchImpl = opts.fetchImpl;
  const clientOpts = {
    apiKey: state.apiKey,
    fetchTimeoutMs: opts.fetchTimeoutMs,
    loadFetchTimeoutMs: opts.loadFetchTimeoutMs,
  };

  // 1. 快路徑
  // 注意：必須重新抓取 catalog，不能沿用呼叫端（model.request hook）已抓的
  // prefetchedCatalog。當本 ensure 被序列化 queue 排在另一個 ensure 後面時，
  // prefetchedCatalog 是過時資料（可能顯示目標已載入，但實際上已被前一個
  // ensure 的 unload-all 卸載），用過時資料做 fast path 判斷會讓請求在模型
  // 未載入時直接放行 → "Model is unloaded"。
  const catalog0 = await fetchModels(baseURL, fetchImpl, clientOpts);
  const loaded0 = listLoadedFromModels(catalog0);
  if (isVerifiedFastPath(state, fullKey, loaded0, opts)) {
    return { fast: true };
  }

  // 3.5. 若 catalog 抓取成功但目標模型不在其中 → 直接失敗，避免 unload 現有模型
  const existsInCatalog = catalog0.some(
    (m) => m.key === fullKey || (m.key ?? "").split("/").pop() === fullKey
  );
  if (catalog0.length > 0 && !existsInCatalog) {
    throw new Error(`LM Studio 模型 ${fullKey} 不存在於模型庫（請確認模型名稱）`);
  }

  // 2. 目標已載入（無論是否唯一）→ 不需重新 load（避免撞 LM Studio 記憶體
  //    guardrail），直接進入 ping 就緒驗證。
  const targetLoaded = loaded0.find((i) => i.modelKey === fullKey) ?? null;
  const others = loaded0.filter((i) => i.modelKey !== fullKey);

  // 3. 卸載其他模型（若 alwaysSingleModel）並等待卸載完成
  let unloadStillThere = [];
  if (opts.alwaysSingleModel && others.length > 0) {
    for (const o of others) {
      await unloadInstance(baseURL, o.instanceId, fetchImpl, clientOpts);
    }
    // 卸載是 async：poll 直到這些 instance 從 catalog 消失，避免 loading
    // 與 engine teardown 競爭。
    const removedIds = new Set(others.map((o) => o.instanceId));
    const unloadDeadline = Date.now() + opts.unloadCompletionTimeoutMs;
    while (Date.now() < unloadDeadline) {
      const cur = listLoadedFromModels(await fetchModels(baseURL, fetchImpl, clientOpts));
      unloadStillThere = cur.filter((i) => removedIds.has(i.instanceId));
      if (unloadStillThere.length === 0) break;
      await sleep(opts.pollIntervalMs);
    }
    if (unloadStillThere.length > 0) {
      console.warn(
        `[lmstudio] 卸載逾時: ${unloadStillThere.map((i) => i.instanceId).join(", ")} 仍在 catalog 中`
      );
    }
  }

  // 4. 目標未載入 → load（transient 錯誤退避重試）→ poll catalog 直到 instance 出現
  let instFound = targetLoaded;
  let latestCatalog = catalog0;
  if (!instFound) {
    let res = await loadModel(baseURL, fullKey, fetchImpl, clientOpts);
    let attempt = 1;
    while (!res.ok && attempt < opts.maxLoadRetries && isRetryableLoadError(res)) {
      const delay = opts.loadRetryBaseDelayMs * 2 ** (attempt - 1);
      console.warn(
        `[lmstudio] 載入 ${fullKey} 失敗 (${httpErrorToString(res)})，${delay}ms 後重試 (${attempt}/${opts.maxLoadRetries})`
      );
      await sleep(delay);
      res = await loadModel(baseURL, fullKey, fetchImpl, clientOpts);
      attempt += 1;
    }
    if (!res.ok) {
      throw new Error(`LM Studio 載入失敗: ${httpErrorToString(res)}`);
    }

    const loadDeadline = Date.now() + opts.loadTimeoutMs;
    while (Date.now() < loadDeadline) {
      latestCatalog = await fetchModels(baseURL, fetchImpl, clientOpts);
      const cur = listLoadedFromModels(latestCatalog);
      instFound = cur.find((i) => i.modelKey === fullKey) ?? null;
      if (instFound) break;
      await sleep(opts.pollIntervalMs);
    }
    if (!instFound) {
      throw new Error(
        `LM Studio 載入逾時: ${opts.loadTimeoutMs / 1000}s 內未看到 ${fullKey} 的執行實體`
      );
    }
  }

  // 目標若是 embedding 模型，跳過 chat ping（embeddings 不走 chat/completions）
  // 用最新 catalog 判斷，避免 load 前抓取的 catalog 過時。
  const entry =
    latestCatalog.find((m) => m.key === fullKey) ??
    latestCatalog.find((m) => (m.key ?? "").split("/").pop() === fullKey);
  const isEmbedding = entry?.type === "embedding";

  // 5. ping 就緒驗證
  if (opts.pingEnabled && !isEmbedding) {
    const pingDeadline = Date.now() + opts.readyTimeoutMs;
    let lastErr = null;
    while (Date.now() < pingDeadline) {
      try {
        await chatPing(baseURL, fullKey, fetchImpl, {
          ...clientOpts,
          pingMaxTokens: opts.pingMaxTokens,
        });
        state.verified.set(fullKey, { instanceId: instFound.instanceId, ts: Date.now() });
        return { fast: false };
      } catch (err) {
        lastErr = err;
        if (isUnloadedMessage(err?.message)) {
          // 引擎載入後又死了 → 重新載入（best-effort）並更新 instance
          console.warn(`[lmstudio] ${fullKey} ping 偵測到 Model is unloaded，重新載入`);
          await loadModel(baseURL, fullKey, fetchImpl, clientOpts).catch((e) =>
            console.warn(`[lmstudio] 重新載入 ${fullKey} 失敗:`, e)
          );
          const nudgeDeadline = Date.now() + opts.nudgePollTimeoutMs;
          while (Date.now() < nudgeDeadline) {
            const cur = listLoadedFromModels(await fetchModels(baseURL, fetchImpl, clientOpts));
            const ni = cur.find((i) => i.modelKey === fullKey);
            if (ni) {
              instFound = ni;
              break;
            }
            await sleep(opts.pollIntervalMs);
          }
        }
        await sleep(opts.pingRetryDelayMs);
      }
    }
    throw new Error(`LM Studio 模型 ${fullKey} 逾時未就緒: ${lastErr?.message ?? "unknown"}`);
  }

  // 6. 寫入 verified cache
  state.verified.set(fullKey, { instanceId: instFound.instanceId, ts: Date.now() });
  return { fast: false };
}

/**
 * 將 ensure 任務送入「全域序列化 queue」。
 *
 * - 同一個 fullKey 的並發請求共享同一個 promise（inFlight 合併）。
 * - 不同 fullKey 的 ensure 依序執行（queue 序列化），避免 A 剛載入完成就被
 *   B 的 unload-all 卸載 → 這是「重開 session 出現 Model is unloaded」的主因。
 * - queue 上的錯誤會被遮蔽（.then(noop, noop)），不會 poison 後續任務。
 *
 * @param {{queue: Promise, inFlight: Map}} state - plugin 狀態
 * @param {string} fullKey - 完整模型 key
 * @param {object} opts - plugin 選項
 * @returns {Promise<{fast: boolean}>}
 */
function enqueueEnsure(state, fullKey, opts) {
  if (state.inFlight.has(fullKey)) return state.inFlight.get(fullKey);

  const p = (async () => {
    state.queue = state.queue
      .then(() => undefined, () => undefined)
      .then(() => ensureLoaded(state, fullKey, opts));
    await state.queue;
  })();
  // 完成/失敗後都從 inFlight 移除（後續請求會透過 verified cache 直通，
  // 或重新完整 ensure 自我修復）
  const cleanup = () => state.inFlight.delete(fullKey);
  p.then(cleanup, cleanup);
  state.inFlight.set(fullKey, p);
  return p;
}

// ─── Plugin 主程式（V2：default export 物件 + setup(ctx)）────────

/**
 * LM Studio Model Loader Plugin（V2 純 V2 版，唯一的 export）。
 *
 * V2 結構：`export default { id, async setup(ctx) }`，setup 回傳 cleanup
 * function（V2 lifecycle：setup 載入時執行，回傳值於 unload 時執行）。
 *
 * 註冊與訂閱：
 * - `model.request`（scoped to opts.providerID）：LLM 請求前確保目標模型已
 *   載入且「引擎真的可以推論」才放行（序列化 queue + 就緒驗證 + verified
 *   cache）。失敗時 catch → console.warn 詳訊 → rethrow 中文錯誤中止請求
 *   （per A1 實測：hook throw 會中止 HTTP 派發且不傷害 plugin/server）。
 * - `retry`（scoped）：provider 請求層失敗後、排定重試前觸發（per A2 實測：
 *   attempt 從 2 開始）。失效 verified cache 並 await ensure；ensure 成功才
 *   覆寫 `event.decision = { retry: true, delay: 0 }`，失敗不動 decision。
 *   復原受 maxRecoveryAttempts 限制（預設 2 → 只在 attempt ≤ 2 復原）。
 * - `ctx.event.subscribe`（server 全域事件流，只處理本 plugin 相關型別）：
 *   - `session.execution.failed`：V2 無 session.error，錯誤在 data.error。
 *     萃取訊息 → isUnloadedMessage → 失效快取 → 250ms 後背景 enqueueEnsure。
 *   - `session.deleted`：清理 session→model 記錄。
 * - cleanup：abort 事件訂閱 + dispose hook registrations + 清光 timers。
 *
 * 選項優先序：ctx.options（使用者顯式設定，hasOwnProperty 判斷）
 * > provider settings（ctx.provider.get(...).data.settings）> 內建預設。
 * model.request 的 event.baseURL 可更新「未顯式設定」的 opts.baseURL。
 *
 * @param {object} ctx - V2 plugin context（ctx.options / ctx.provider /
 *   ctx.session / ctx.event / ctx.app）
 * @returns {Promise<Function>} cleanup function（unload 時執行）
 */
export default {
  id: "lmstudio-model-loader",
  async setup(ctx) {
    // 合併使用者選項與預設值（V2 由 ctx.options 傳入，可能為 undefined）
    const userOptions = ctx.options ?? {};
    const opts = {
      baseURL: "http://127.0.0.1:1234",
      providerID: "lmstudio",
      alwaysSingleModel: true,
      fetchImpl: globalThis.fetch,
      loadTimeoutMs: 300000,
      readyTimeoutMs: 300000,
      unloadCompletionTimeoutMs: 15000,
      maxLoadRetries: 3,
      loadRetryBaseDelayMs: 1500,
      readyTTLMs: 90000,
      pingEnabled: true,
      pingMaxTokens: 1,
      pollIntervalMs: 1000,
      pingRetryDelayMs: 1500,
      nudgePollTimeoutMs: 15000,
      fetchTimeoutMs: 10000,
      loadFetchTimeoutMs: 30000,
      maxSessionModels: 500,
      maxRecoveryAttempts: 2, // retry hook 復原上限（attempt 從 2 開始，per A2）
      apiKey: undefined,
      ...userOptions,
    };
    if (typeof opts.fetchImpl !== "function") opts.fetchImpl = globalThis.fetch;
    if (typeof opts.maxRecoveryAttempts !== "number" || !Number.isFinite(opts.maxRecoveryAttempts)) {
      opts.maxRecoveryAttempts = 2;
    }

    // 讀取 provider settings（V1 的 client.provider.create 已由 opencode.json
    // providers 區塊取代；V2 讀法：ctx.provider.get → result.data.settings）。
    // 優先序：使用者顯式設定 > provider settings > 內建預設。
    let providerSettings = {};
    try {
      const res = await ctx.provider.get({ providerID: opts.providerID });
      providerSettings = (res && res.data && res.data.settings) || {};
    } catch (e) {
      console.warn(`[lmstudio] 讀取 provider ${opts.providerID} settings 失敗:`, e?.message ?? e);
    }
    if (
      !Object.prototype.hasOwnProperty.call(userOptions, "baseURL") &&
      typeof providerSettings.baseURL === "string" &&
      providerSettings.baseURL
    ) {
      opts.baseURL = providerSettings.baseURL;
    }
    if (
      !Object.prototype.hasOwnProperty.call(userOptions, "apiKey") &&
      typeof providerSettings.apiKey === "string" &&
      providerSettings.apiKey
    ) {
      opts.apiKey = providerSettings.apiKey;
    }
    // 正規化 baseURL：移除尾綴 `/` 與 `/v1`（避免與 provider 設定的 `/v1` 慣例混淆）
    opts.baseURL = normalizeBaseURL(opts.baseURL);

    console.log(
      `[lmstudio] plugin loaded (opencode ${ctx.app?.version ?? "?"}) providerID=${opts.providerID} baseURL=${opts.baseURL}`
    );

    // 每個 plugin 實例一份狀態
    const state = {
      queue: Promise.resolve(), // 全域序列化鏈
      inFlight: new Map(), // fullKey -> Promise（同 model 並發合併）
      verified: new Map(), // fullKey -> {instanceId, ts}
      sessionModels: new Map(), // sessionID -> {fullKey, providerID}
      apiKey: opts.apiKey, // LM Studio API token（選項 / provider settings 提供）
      pending: new Set(), // pending request tokens for conflict detection
    };
    const timers = new Set(); // 可取消的背景 timer（cleanup 時清理）
    const controller = new AbortController(); // 事件訂閱生命週期（cleanup 時 abort）
    // 使用者是否「顯式」設定某選項（顯式設定 > provider settings / event 動態值）
    const hasOpt = (key) => Object.prototype.hasOwnProperty.call(userOptions, key);

    // ─── model.request hook（scoped，V1 chat.params 的對應）──────────
    const modelRequestRegistration = await ctx.session.hook(
      "model.request",
      async (event) => {
        // 1. 過濾：僅處理目標 provider（scoped 註冊已保證，此處雙保險）
        const providerId = event?.model?.providerID;
        if (providerId !== opts.providerID) {
          return;
        }

        // 2. event.baseURL 是 opencode 實際要用的 provider URL；使用者未顯式
        //    設定 baseURL 時同步（過 normalizeBaseURL 轉為 root）
        if (!hasOpt("baseURL") && typeof event.baseURL === "string" && event.baseURL) {
          const fromEvent = normalizeBaseURL(event.baseURL);
          if (fromEvent && fromEvent !== opts.baseURL) {
            opts.baseURL = fromEvent;
          }
        }

        // 3. 取得目標 modelID，並建立 pending token
        const targetKey = event?.model?.id;
        if (!targetKey) {
          return;
        }
        const pendingToken = { raw: targetKey, full: null };
        state.pending.add(pendingToken);

        try {
          const catalog = await fetchModels(opts.baseURL, opts.fetchImpl, {
            apiKey: state.apiKey,
            fetchTimeoutMs: opts.fetchTimeoutMs,
          });
          const loaded = listLoadedFromModels(catalog);
          const fullKey = resolveKeyFromCatalog(catalog, targetKey);
          pendingToken.full = fullKey;

          // 4. 記錄 session→model（供事件/retry hook 定位模型）
          //    容量上限：超過 maxSessionModels 時刪除最舊的記錄，避免無界成長。
          if (event.sessionID) {
            if (state.sessionModels.size >= opts.maxSessionModels) {
              const oldest = state.sessionModels.keys().next().value;
              state.sessionModels.delete(oldest);
            }
            state.sessionModels.set(event.sessionID, {
              fullKey,
              providerID: providerId,
            });
          }

          // 5. 快路徑：已驗證就緒且無衝突 → 直接放行（零額外延遲）
          if (isVerifiedFastPath(state, fullKey, loaded, opts) && !hasModelConflict(state, pendingToken, fullKey)) {
            console.log(`[lmstudio] 目標 ${fullKey} 已驗證就緒，直接放行`);
            return;
          }

          // 6. 序列化 ensure（同 model 並發會共享同一 promise）
          const p = enqueueEnsure(state, fullKey, opts);
          await p;
        } catch (e) {
          console.warn(`[lmstudio] 確保 ${pendingToken?.full ?? targetKey} 就緒失敗:`, e);
          throw new Error(
            `LM Studio 模型 ${pendingToken?.full ?? targetKey} 載入/就緒失敗（請確認 LM Studio 已啟動且模型存在）: ${e?.message ?? e}`
          );
        } finally {
          state.pending.delete(pendingToken);
        }
      },
      { providerID: opts.providerID }
    );

    // ─── retry hook（scoped，V1 session.error 復原的對應機制之一）────
    const retryRegistration = await ctx.session.hook(
      "retry",
      async (event) => {
        // 1. 過濾：僅處理目標 provider（scoped 註冊已保證，此處雙保險）
        if (event?.model?.providerID !== opts.providerID) {
          return;
        }

        // 2. 復原上限：attempt 從 2 開始（A2 實測），maxRecoveryAttempts
        //    預設 2 → 只在 attempt ≤ 2 時復原；超過後沿用 opencode 預設
        //    decision（退避重試或終端失敗）。
        if (typeof event.attempt !== "number" || event.attempt > opts.maxRecoveryAttempts) {
          return;
        }

        // 3. 定位 fullKey：優先 session→model 記錄，否則由 catalog 解析
        let fullKey = null;
        const rec = state.sessionModels.get(event.sessionID);
        if (rec && rec.providerID === opts.providerID) {
          fullKey = rec.fullKey;
        } else if (event.model?.id) {
          try {
            const catalog = await fetchModels(opts.baseURL, opts.fetchImpl, {
              apiKey: state.apiKey,
              fetchTimeoutMs: opts.fetchTimeoutMs,
            });
            fullKey = resolveKeyFromCatalog(catalog, event.model.id);
          } catch (e) {
            console.warn(`[lmstudio] retry 復原：解析模型 key 失敗:`, e?.message ?? e);
            return;
          }
        }
        if (!fullKey) {
          return;
        }

        // 4. 失效 verified cache → 完整 ensure（unload → load → ping 就緒驗證）
        state.verified.delete(fullKey);
        try {
          await enqueueEnsure(state, fullKey, opts);
        } catch (e) {
          // 復原失敗：不動 opencode 的 decision（沿用預設退避/終端失敗）
          console.warn(`[lmstudio] retry 復原 ensure ${fullKey} 失敗:`, e?.message ?? e);
          return;
        }
        console.log(`[lmstudio] retry 復原成功（attempt=${event.attempt}），立即重試 ${fullKey}`);
        event.decision = { retry: true, delay: 0 };
      },
      { providerID: opts.providerID }
    );

    // ─── 事件訂閱（V1 event hook → ctx.event.subscribe 全域事件流）───
    // V2 envelope：payload 一律在 event.data（FINDINGS 實測）；以 ev.data
    // 優先、ev.properties 防呆相容。
    void (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
          if (!ev || typeof ev.type !== "string") continue;
          try {
            const data = ev.data ?? ev.properties ?? {};

            // session.deleted → 清理 session→model 記錄（避免無界成長）
            if (ev.type === "session.deleted") {
              if (data.sessionID) state.sessionModels.delete(data.sessionID);
              continue;
            }

            // session.execution.failed（V1 session.error 的對應）→
            // 偵測 "Model is unloaded" 後失效快取並背景預載，
            // 讓使用者重送的下一發請求直接走快路徑成功。
            if (ev.type !== "session.execution.failed") {
              continue;
            }
            const text = extractErrorMessage(data.error);
            if (!isUnloadedMessage(text)) {
              continue;
            }
            const sessionID = data.sessionID;
            if (!sessionID) continue;
            const rec = state.sessionModels.get(sessionID);
            if (!rec || rec.providerID !== opts.providerID) continue;

            state.verified.delete(rec.fullKey);
            console.warn(
              `[lmstudio] 偵測到 "${text}"（session ${sessionID}），失效快取並預載 ${rec.fullKey}`
            );

            // 背景預載（fire-and-forget，與 model.request 走同一序列化 queue）
            // timer 記錄在 timers Set，cleanup 時可取消。
            const t = setTimeout(() => {
              timers.delete(t);
              enqueueEnsure(state, rec.fullKey, opts).catch((e) =>
                console.warn(`[lmstudio] 背景預載 ${rec.fullKey} 失敗:`, e)
              );
            }, 250);
            timers.add(t);
          } catch (e) {
            console.warn(`[lmstudio] 事件處理失敗:`, e?.message ?? e);
          }
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          console.warn(`[lmstudio] event.subscribe 異常結束:`, e?.message ?? e);
        }
      }
    })();

    // ─── cleanup（V2 setup 回傳值，plugin unload 時執行）─────────────
    return () => {
      controller.abort(); // 中止事件訂閱 loop
      for (const r of [modelRequestRegistration, retryRegistration]) {
        try {
          Promise.resolve(typeof r?.dispose === "function" ? r.dispose() : undefined).catch(() => {});
        } catch {
          // dispose 失敗不影響 unload
        }
      }
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  },
};
