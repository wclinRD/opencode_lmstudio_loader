/**
 * 系統測試：lmstudio-model-loader 完整流程（透過 plugin hooks + mock fetch）。
 *
 * 以 mock fetch 模擬 LM Studio API，透過 chat.params / event hook 觸發
 * 完整行為，驗證各項修正（C1/H1/H2/H3/M1-M5/L1）。
 *
 * 執行：node --test tests/lmstudio-model-loader/system.test.mjs
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import plugin from "../../plugins/lmstudio-model-loader.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 建立 mock fetch。記錄所有呼叫，依 URL pattern 回應。
 *
 * @param {object} spec - { models, loaded, chatOk, hangUrls }
 * @param {Array} spec.models - GET /api/v1/models 回傳的 models 陣列
 * @param {Array} spec.loaded - load 成功後加入 loaded_instances 的模型
 * @param {boolean} spec.chatOk - chat/completions 是否成功
 * @param {Set<string>} spec.hangUrls - 永不回應的 URL（尊重 abort signal）
 * @returns {{fetch: Function, calls: Array}}
 */
function makeFetch(spec = {}) {
  const calls = [];
  const models = spec.models ?? [];
  const loadedAfterLoad = spec.loaded ?? [];
  const unloadedIds = new Set();
  let loadCalled = false;
  const fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (spec.hangUrls?.has(url.split("?")[0]) || spec.hangAll) {
      return new Promise((_, reject) => {
        opts?.signal?.addEventListener("abort", () => reject(new Error("Aborted")));
      });
    }
    if (url.endsWith("/api/v1/models")) {
      let current = models;
      if (loadCalled) {
        // 模擬 load 後出現在 catalog
        current = [...models, ...loadedAfterLoad];
      }
      // 模擬 unload 後從 catalog 移除（清空 loaded_instances）
      current = current.map((m) => ({
        ...m,
        loaded_instances: (m.loaded_instances ?? []).filter((i) => !unloadedIds.has(i.id)),
      }));
      return { ok: true, status: 200, json: async () => ({ models: current }) };
    }
    if (url.endsWith("/api/v1/models/load")) {
      loadCalled = true;
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (url.endsWith("/api/v1/models/unload")) {
      const body = JSON.parse(opts?.body ?? "{}");
      if (body.instance_id) unloadedIds.add(body.instance_id);
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (url.endsWith("/v1/chat/completions")) {
      if (spec.chatOk === false) {
        return { ok: false, status: 500, json: async () => ({ error: { message: "Model is unloaded." } }) };
      }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "pong" } }] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetch, calls };
}

const SDK_UNLOADED_ERROR = {
  name: "APIError",
  data: { message: "Model is unloaded", statusCode: 500, isRetryable: true, responseBody: '{"error":{"message":"Model is unloaded"}}' },
};

describe("系統測試：lmstudio-model-loader", () => {
  test("首次請求：完整 ensure（load → poll → ping）→ 成功", async () => {
    const { fetch, calls } = makeFetch({
      models: [{ key: "qwen/qwen3.6-35b-a3b", display_name: "Qwen", type: "llm", loaded_instances: [] }],
      loaded: [{ key: "qwen/qwen3.6-35b-a3b", display_name: "Qwen", type: "llm", loaded_instances: [{ id: "i1", config: {} }] }],
    });
    const hooks = await plugin({}, { fetchImpl: fetch, baseURL: "http://127.0.0.1:1234" });
    await hooks["chat.params"]({ sessionID: "s1", model: { id: "qwen3.6-35b-a3b", providerID: "lmstudio" } }, {});
    const urls = calls.map((c) => c.url);
    assert.ok(urls.some((u) => u.endsWith("/api/v1/models/load")), "應呼叫 load");
    assert.ok(urls.some((u) => u.endsWith("/v1/chat/completions")), "應呼叫 chat ping");
    await hooks.dispose?.();
  });

  test("第二次請求：快路徑（僅 1 次 catalog fetch）", async () => {
    const { fetch, calls } = makeFetch({
      models: [{ key: "qwen/qwen3.6-35b-a3b", display_name: "Qwen", type: "llm", loaded_instances: [{ id: "i1", config: {} }] }],
    });
    const hooks = await plugin({}, { fetchImpl: fetch, baseURL: "http://127.0.0.1:1234" });
    await hooks["chat.params"]({ sessionID: "s1", model: { id: "qwen3.6-35b-a3b", providerID: "lmstudio" } }, {});
    const afterFirst = calls.length;
    await hooks["chat.params"]({ sessionID: "s1", model: { id: "qwen3.6-35b-a3b", providerID: "lmstudio" } }, {});
    const delta = calls.length - afterFirst;
    assert.equal(delta, 1, `快路徑應僅 1 次 catalog fetch，實際 ${delta} 次`);
    await hooks.dispose?.();
  });

  test("C1：event hook 收到 SDK 錯誤結構 → 偵測 unloaded → 背景預載", async () => {
    const { fetch, calls } = makeFetch({
      models: [{ key: "qwen/qwen3.6-35b-a3b", display_name: "Qwen", type: "llm", loaded_instances: [{ id: "i1", config: {} }] }],
    });
    const hooks = await plugin({}, { fetchImpl: fetch, baseURL: "http://127.0.0.1:1234" });
    await hooks["chat.params"]({ sessionID: "s1", model: { id: "qwen3.6-35b-a3b", providerID: "lmstudio" } }, {});
    const before = calls.length;
    await hooks.event({ event: { type: "session.error", properties: { sessionID: "s1", error: SDK_UNLOADED_ERROR } } });
    await sleep(600); // 250ms timer + ensure
    const delta = calls.length - before;
    assert.ok(delta > 0, "event hook 應觸發背景預載（有新 fetch 呼叫）");
    await hooks.dispose?.();
  });

  test("H2：alwaysSingleModel:false + 多模型 → 快路徑生效", async () => {
    const { fetch, calls } = makeFetch({
      models: [
        { key: "qwen/qwen3.6-35b-a3b", display_name: "Qwen", type: "llm", loaded_instances: [{ id: "i1", config: {} }] },
        { key: "nomic/nomic-embed", display_name: "Nomic", type: "embedding", loaded_instances: [{ id: "i2", config: {} }] },
      ],
    });
    const hooks = await plugin({}, { fetchImpl: fetch, baseURL: "http://127.0.0.1:1234", alwaysSingleModel: false });
    await hooks["chat.params"]({ sessionID: "s1", model: { id: "qwen3.6-35b-a3b", providerID: "lmstudio" } }, {});
    const afterFirst = calls.length;
    await hooks["chat.params"]({ sessionID: "s1", model: { id: "qwen3.6-35b-a3b", providerID: "lmstudio" } }, {});
    const delta = calls.length - afterFirst;
    assert.equal(delta, 1, `快路徑應僅 1 次 catalog fetch，實際 ${delta} 次`);
    await hooks.dispose?.();
  });

  test("H3：baseURL 帶 /v1 尾綴 → normalize 後 URL 正確", async () => {
    const { fetch, calls } = makeFetch({ models: [] });
    const hooks = await plugin({}, {
      fetchImpl: fetch,
      baseURL: "http://127.0.0.1:1234/v1",
      loadTimeoutMs: 2000,
      pollIntervalMs: 50,
    });
    try {
      await hooks["chat.params"]({ sessionID: "s1", model: { id: "m", providerID: "lmstudio" } }, {});
    } catch {
      // 預期失敗（模型不存在）
    }
    const urls = calls.map((c) => c.url);
    assert.ok(urls.every((u) => !u.includes("/v1/api/v1")), "不應有 /v1/api/v1 雙重路徑");
    assert.ok(urls.some((u) => u.endsWith("/api/v1/models/load")), "load URL 應為 .../api/v1/models/load");
    await hooks.dispose?.();
  });

  test("M5：apiKey → 所有請求帶 Authorization header", async () => {
    const { fetch, calls } = makeFetch({ models: [] });
    const hooks = await plugin({}, {
      fetchImpl: fetch,
      baseURL: "http://127.0.0.1:1234",
      apiKey: "secret-token",
      loadTimeoutMs: 2000,
      pollIntervalMs: 50,
    });
    try {
      await hooks["chat.params"]({ sessionID: "s1", model: { id: "m", providerID: "lmstudio" } }, {});
    } catch {
      // 預期失敗
    }
    const withAuth = calls.filter((c) => c.opts?.headers?.Authorization === "Bearer secret-token");
    assert.equal(withAuth.length, calls.length, `所有請求應帶 Authorization（${withAuth.length}/${calls.length}）`);
    await hooks.dispose?.();
  });

  test("H1：fetch 永不回應 → timeout 後失敗（不永久卡住）", async () => {
    const { fetch, calls } = makeFetch({ models: [], hangAll: true });
    // 讓 load 也走正常回應（避免 hang 在 load），只 hang chat
    const fetch2 = async (url, opts) => {
      calls.push({ url, opts });
      if (url.endsWith("/api/v1/models")) return { ok: true, status: 200, json: async () => ({ models: [] }) };
      if (url.endsWith("/api/v1/models/load")) return { ok: true, status: 200, json: async () => ({}) };
      return new Promise((_, reject) => {
        opts?.signal?.addEventListener("abort", () => reject(new Error("Aborted")));
      });
    };
    const hooks = await plugin({}, {
      fetchImpl: fetch2,
      baseURL: "http://127.0.0.1:1234",
      fetchTimeoutMs: 300,
      loadFetchTimeoutMs: 300,
      loadTimeoutMs: 2000,
      pingRetryDelayMs: 50,
      readyTimeoutMs: 2000,
      nudgePollTimeoutMs: 500,
      pollIntervalMs: 50,
    });
    const t0 = Date.now();
    await assert.rejects(
      () => hooks["chat.params"]({ sessionID: "s1", model: { id: "m", providerID: "lmstudio" } }, {}),
      (e) => {
        assert.ok(e.message.includes("請確認 LM Studio"), "錯誤訊息應含排除指引（L1）");
        return true;
      }
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 10000, `不應永久卡住（耗時 ${elapsed}ms）`);
    await hooks.dispose?.();
  });

  test("M2：session.deleted → 清理 sessionModels", async () => {
    const { fetch, calls } = makeFetch({
      models: [{ key: "m", display_name: "M", type: "llm", loaded_instances: [{ id: "i1", config: {} }] }],
    });
    const hooks = await plugin({}, { fetchImpl: fetch, baseURL: "http://127.0.0.1:1234" });
    await hooks["chat.params"]({ sessionID: "s1", model: { id: "m", providerID: "lmstudio" } }, {});
    await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "s1" } } } });
    const before = calls.length;
    // session 已刪除 → error 事件不應觸發預載
    await hooks.event({ event: { type: "session.error", properties: { sessionID: "s1", error: SDK_UNLOADED_ERROR } } });
    await sleep(600);
    assert.equal(calls.length, before, "session 刪除後不應觸發預載");
    await hooks.dispose?.();
  });

  test("M4：dispose 後不會執行 pending timer", async () => {
    const { fetch, calls } = makeFetch({
      models: [{ key: "m", display_name: "M", type: "llm", loaded_instances: [{ id: "i1", config: {} }] }],
    });
    const hooks = await plugin({}, { fetchImpl: fetch, baseURL: "http://127.0.0.1:1234" });
    await hooks["chat.params"]({ sessionID: "s1", model: { id: "m", providerID: "lmstudio" } }, {});
    await hooks.event({ event: { type: "session.error", properties: { sessionID: "s1", error: SDK_UNLOADED_ERROR } } });
    await hooks.dispose?.(); // 立刻 dispose，取消 pending 250ms timer
    const before = calls.length;
    await sleep(600);
    assert.equal(calls.length, before, "dispose 後 timer 不應執行");
  });

  test("非目標 provider 直接放行（零呼叫）", async () => {
    const { fetch, calls } = makeFetch({ models: [] });
    const hooks = await plugin({}, { fetchImpl: fetch, baseURL: "http://127.0.0.1:1234" });
    await hooks["chat.params"]({ sessionID: "s1", model: { id: "m", providerID: "other" } }, {});
    assert.equal(calls.length, 0, "非 lmstudio provider 不應呼叫 API");
    await hooks.dispose?.();
  });

  test("embedding 模型跳過 chat ping", async () => {
    const { fetch, calls } = makeFetch({
      models: [{ key: "nomic/nomic-embed", display_name: "Nomic", type: "embedding", loaded_instances: [{ id: "i1", config: {} }] }],
    });
    const hooks = await plugin({}, { fetchImpl: fetch, baseURL: "http://127.0.0.1:1234" });
    await hooks["chat.params"]({ sessionID: "s1", model: { id: "nomic-embed", providerID: "lmstudio" } }, {});
    const urls = calls.map((c) => c.url);
    assert.ok(!urls.some((u) => u.endsWith("/v1/chat/completions")), "embedding 不應呼叫 chat ping");
    assert.ok(!urls.some((u) => u.endsWith("/api/v1/models/load")), "已載入不應重複 load");
    await hooks.dispose?.();
  });

  test("alwaysSingleModel:true：卸載其他模型", async () => {
    const { fetch, calls } = makeFetch({
      models: [
        { key: "qwen/qwen3.6-35b-a3b", display_name: "Qwen", type: "llm", loaded_instances: [{ id: "i1", config: {} }] },
        { key: "other/model", display_name: "Other", type: "llm", loaded_instances: [{ id: "i2", config: {} }] },
      ],
    });
    const hooks = await plugin({}, { fetchImpl: fetch, baseURL: "http://127.0.0.1:1234", alwaysSingleModel: true, unloadCompletionTimeoutMs: 2000, pollIntervalMs: 50 });
    await hooks["chat.params"]({ sessionID: "s1", model: { id: "qwen3.6-35b-a3b", providerID: "lmstudio" } }, {});
    const urls = calls.map((c) => c.url);
    assert.ok(urls.some((u) => u.endsWith("/api/v1/models/unload")), "應卸載其他模型");
    await hooks.dispose?.();
  });

  test("load 失敗拋出含指引的錯誤（L1 + M3）", async () => {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      const fetch = async (url, opts) => {
        if (url.endsWith("/api/v1/models")) return { ok: true, status: 200, json: async () => ({ models: [] }) };
        if (url.endsWith("/api/v1/models/load")) return { ok: false, status: 404, json: async () => ({ error: { message: "model not found" } }) };
        return { ok: false, status: 404, json: async () => ({}) };
      };
      const hooks = await plugin({}, {
        fetchImpl: fetch, baseURL: "http://127.0.0.1:1234",
        maxLoadRetries: 3, loadRetryBaseDelayMs: 10, // 避免測試久等
      });
      await assert.rejects(
        () => hooks["chat.params"]({ sessionID: "s1", model: { id: "missing", providerID: "lmstudio" } }, {}),
        (e) => {
          assert.ok(e.message.includes("請確認 LM Studio"), "應含排除指引");
          assert.ok(e.message.includes("載入/就緒失敗"), "應標示載入失敗");
          return true;
        }
      );
      await hooks.dispose?.();
    } finally {
      console.warn = origWarn;
    }
  });

  test("Bug 1：並發請求不同模型 → qwen3.6-35b-a3b 不走 fast path", async () => {
    const { fetch, calls } = makeFetch({
      models: [
        { key: "qwen/qwen3.6-35b-a3b", display_name: "Qwen", type: "llm", loaded_instances: [{ id: "i1", config: {} }] },
        { key: "other/model", display_name: "Other", type: "llm", loaded_instances: [] },
      ],
      loaded: [
        { key: "other/model", display_name: "Other", type: "llm", loaded_instances: [{ id: "i2", config: {} }] },
        { key: "qwen/qwen3.6-35b-a3b", display_name: "Qwen", type: "llm", loaded_instances: [{ id: "i3", config: {} }] },
      ],
    });
    const hooks = await plugin({}, { fetchImpl: fetch, baseURL: "http://127.0.0.1:1234" });

    // 建立 verified cache
    await hooks["chat.params"]({ sessionID: "s1", model: { id: "qwen3.6-35b-a3b", providerID: "lmstudio" } }, {});
    const afterCache = calls.length;

    // 並發兩個請求：other/model（觸發 unload）與 qwen3.6-35b-a3b
    const p1 = hooks["chat.params"]({ sessionID: "s2", model: { id: "other/model", providerID: "lmstudio" } }, {});
    const p2 = hooks["chat.params"]({ sessionID: "s3", model: { id: "qwen3.6-35b-a3b", providerID: "lmstudio" } }, {});
    await Promise.all([p1, p2]);

    // qwen3.6-35b-a3b 的請求不應該只走 fast path（應有 unload + load 等額外呼叫）
    const afterRace = calls.length;
    const delta = afterRace - afterCache;

    // fast path 只會有 1 次 catalog fetch；但由於 conflict，qwen3.6-35b-a3b 應該觸發 ensure
    // ensure 會包含：catalog fetch + unload (other/model triggers qwen unload) + load + ping
    // 所以 delta 應該大於 1
    assert.ok(delta > 1, `qwen3.6-35b-a3b 不應該只走 fast path（delta=${delta}，fast path 應為 1）`);

    // 驗證有 unload 呼叫（other/model 觸發 unload qwen）
    const unloadCalls = calls.filter((c) => c.url.endsWith("/api/v1/models/unload"));
    assert.ok(unloadCalls.length > 0, "應有 unload 呼叫");

    await hooks.dispose?.();
  });

  test("Bug 4：ensure 排在 queue 後方時重新抓取 catalog（不用過時資料）", async () => {
    // 自訂 mock：模擬 alwaysSingleModel 的 unload-on-load 行為
    const calls = [];
    let qwenLoaded = false; // 初始 qwen 未載入（首次請求會 load）
    let otherLoaded = false;
    const fetch = async (url, opts) => {
      calls.push({ url, opts });
      if (url.endsWith("/api/v1/models")) {
        const current = [
          { key: "qwen/qwen3.6-35b-a3b", type: "llm", loaded_instances: qwenLoaded ? [{ id: "i1", config: {} }] : [] },
          { key: "other/model", type: "llm", loaded_instances: otherLoaded ? [{ id: "i2", config: {} }] : [] },
        ];
        return { ok: true, status: 200, json: async () => ({ models: current }) };
      }
      if (url.endsWith("/api/v1/models/load")) {
        const body = JSON.parse(opts?.body ?? "{}");
        if (body.model === "other/model") { otherLoaded = true; qwenLoaded = false; }
        if (body.model === "qwen/qwen3.6-35b-a3b") { qwenLoaded = true; otherLoaded = false; }
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (url.endsWith("/api/v1/models/unload")) {
        const body = JSON.parse(opts?.body ?? "{}");
        if (body.instance_id === "i1") qwenLoaded = false;
        if (body.instance_id === "i2") otherLoaded = false;
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (url.endsWith("/v1/chat/completions")) {
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "pong" } }] }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    const hooks = await plugin({}, { fetchImpl: fetch, baseURL: "http://127.0.0.1:1234", pollIntervalMs: 20 });

    // 建立 qwen 的 verified cache（首次請求 → load + ping）
    await hooks["chat.params"]({ sessionID: "s1", model: { id: "qwen3.6-35b-a3b", providerID: "lmstudio" } }, {});
    const qwenLoadsAfterFirst = calls.filter((c) => c.url.endsWith("/api/v1/models/load") && JSON.parse(c.opts?.body ?? "{}").model === "qwen/qwen3.6-35b-a3b").length;
    assert.equal(qwenLoadsAfterFirst, 1, "首次請求應 load qwen 一次");

    // 並發：other/model（會 unload qwen）+ qwen（原本會用過時 catalog 走 fast path）
    const p1 = hooks["chat.params"]({ sessionID: "s2", model: { id: "other/model", providerID: "lmstudio" } }, {});
    const p2 = hooks["chat.params"]({ sessionID: "s3", model: { id: "qwen3.6-35b-a3b", providerID: "lmstudio" } }, {});
    await Promise.all([p1, p2]);

    // qwen 的 ensure 排在 other/model 後面，必須重新抓取 catalog 發現 qwen 已被卸載 → 重新 load
    const qwenLoadsTotal = calls.filter((c) => c.url.endsWith("/api/v1/models/load") && JSON.parse(c.opts?.body ?? "{}").model === "qwen/qwen3.6-35b-a3b").length;
    assert.equal(qwenLoadsTotal, 2, `qwen 應被重新載入（共 2 次 load，實際 ${qwenLoadsTotal}）`);

    // 最終 qwen 必須是載入狀態（否則真實 LLM 請求會得到 Model is unloaded）
    assert.equal(qwenLoaded, true, "最終 qwen 應已載入");

    await hooks.dispose?.();
  });
});