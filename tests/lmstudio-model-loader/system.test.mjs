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
});