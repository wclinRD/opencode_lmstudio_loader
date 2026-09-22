/**
 * 單元測試：lmstudio-model-loader 的純函式。
 *
 * 透過 helpers.mjs 從 plugin 原始碼提取自包含的純函式進行測試。
 * 執行：node --test tests/lmstudio-model-loader/unit.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadFunction } from "./helpers.mjs";

const extractErrorMessage = loadFunction("extractErrorMessage");
const isVerifiedFastPath = loadFunction("isVerifiedFastPath");
const resolveKeyFromCatalog = loadFunction("resolveKeyFromCatalog");
const isRetryableLoadError = loadFunction("isRetryableLoadError");
const httpErrorToString = loadFunction("httpErrorToString");
const listLoadedFromModels = loadFunction("listLoadedFromModels");
const normalizeBaseURL = loadFunction("normalizeBaseURL");
const isUnloadedMessage = loadFunction("isUnloadedMessage");

describe("extractErrorMessage（C1 修正）", () => {
  test("SDK NamedError 結構 { name, data: { message } } → 回傳 data.message", () => {
    const err = { name: "APIError", data: { message: "Model is unloaded", statusCode: 500, isRetryable: true } };
    assert.equal(extractErrorMessage(err), "Model is unloaded");
  });

  test("UnknownError 結構 → 回傳 data.message", () => {
    const err = { name: "UnknownError", data: { message: "something broke", ref: "abc" } };
    assert.equal(extractErrorMessage(err), "something broke");
  });

  test("live NamedError 實例（message = 錯誤名稱）→ 優先 data.message", () => {
    const err = { message: "APIError", data: { message: "Model is unloaded" } };
    assert.equal(extractErrorMessage(err), "Model is unloaded");
  });

  test("原生 Error 結構 { message } → 回傳 message", () => {
    assert.equal(extractErrorMessage({ message: "hello" }), "hello");
  });

  test("LM Studio 錯誤格式 { error: { message } } → 回傳巢狀 message", () => {
    assert.equal(extractErrorMessage({ error: { message: "nested error" } }), "nested error");
  });

  test("深層巢狀 → 遞迴找到 message", () => {
    assert.equal(extractErrorMessage({ a: { b: { message: "deep" } } }), "deep");
  });

  test("只有 name 沒有 message → 回傳空字串（不誤回傳 name）", () => {
    assert.equal(extractErrorMessage({ name: "APIError" }), "");
  });

  test("null / undefined → 空字串", () => {
    assert.equal(extractErrorMessage(null), "");
    assert.equal(extractErrorMessage(undefined), "");
  });

  test("字串直接回傳", () => {
    assert.equal(extractErrorMessage("Model is unloaded"), "Model is unloaded");
  });

  test("空物件 → 空字串", () => {
    assert.equal(extractErrorMessage({}), "");
  });
});

describe("isVerifiedFastPath（H2 修正）", () => {
  const state = { verified: new Map() };
  const baseOpts = { readyTTLMs: 90000, alwaysSingleModel: true };
  const loadedSingle = [{ instanceId: "i1", modelKey: "qwen/qwen3.6-35b-a3b" }];
  const loadedMulti = [
    { instanceId: "i1", modelKey: "qwen/qwen3.6-35b-a3b" },
    { instanceId: "i2", modelKey: "nomic/nomic-embed" },
  ];

  test("alwaysSingleModel:true + 唯一載入 + verified + 未過期 → true", () => {
    const s = { verified: new Map([["qwen/qwen3.6-35b-a3b", { instanceId: "i1", ts: Date.now() }]]) };
    assert.equal(isVerifiedFastPath(s, "qwen/qwen3.6-35b-a3b", loadedSingle, baseOpts), true);
  });

  test("alwaysSingleModel:true + 多模型載入 → false", () => {
    const s = { verified: new Map([["qwen/qwen3.6-35b-a3b", { instanceId: "i1", ts: Date.now() }]]) };
    assert.equal(isVerifiedFastPath(s, "qwen/qwen3.6-35b-a3b", loadedMulti, baseOpts), false);
  });

  test("alwaysSingleModel:false + 多模型載入 + verified → true（H2 修正）", () => {
    const s = { verified: new Map([["qwen/qwen3.6-35b-a3b", { instanceId: "i1", ts: Date.now() }]]) };
    const opts = { ...baseOpts, alwaysSingleModel: false };
    assert.equal(isVerifiedFastPath(s, "qwen/qwen3.6-35b-a3b", loadedMulti, opts), true);
  });

  test("目標未載入 → false", () => {
    const s = { verified: new Map([["qwen/qwen3.6-35b-a3b", { instanceId: "i1", ts: Date.now() }]]) };
    assert.equal(isVerifiedFastPath(s, "other/model", loadedSingle, baseOpts), false);
  });

  test("verified cache 不存在 → false", () => {
    assert.equal(isVerifiedFastPath(state, "qwen/qwen3.6-35b-a3b", loadedSingle, baseOpts), false);
  });

  test("instanceId 不符（被替換/重載）→ false", () => {
    const s = { verified: new Map([["qwen/qwen3.6-35b-a3b", { instanceId: "OLD", ts: Date.now() }]]) };
    assert.equal(isVerifiedFastPath(s, "qwen/qwen3.6-35b-a3b", loadedSingle, baseOpts), false);
  });

  test("cache 過期 → false", () => {
    const s = { verified: new Map([["qwen/qwen3.6-35b-a3b", { instanceId: "i1", ts: Date.now() - 100000 }]]) };
    assert.equal(isVerifiedFastPath(s, "qwen/qwen3.6-35b-a3b", loadedSingle, baseOpts), false);
  });
});

describe("resolveKeyFromCatalog", () => {
  const catalog = [
    { key: "qwen/qwen3.6-35b-a3b", display_name: "Qwen3.6 35B" },
    { key: "nomic/nomic-embed", display_name: "Nomic Embed" },
  ];

  test("精確 key 匹配", () => {
    assert.equal(resolveKeyFromCatalog(catalog, "qwen/qwen3.6-35b-a3b"), "qwen/qwen3.6-35b-a3b");
  });

  test("tail 匹配（短 id）", () => {
    assert.equal(resolveKeyFromCatalog(catalog, "qwen3.6-35b-a3b"), "qwen/qwen3.6-35b-a3b");
  });

  test("display_name 匹配", () => {
    assert.equal(resolveKeyFromCatalog(catalog, "Nomic Embed"), "nomic/nomic-embed");
  });

  test("找不到 → 回傳原 id", () => {
    assert.equal(resolveKeyFromCatalog(catalog, "unknown/model"), "unknown/model");
  });

  test("空 catalog → 回傳原 id", () => {
    assert.equal(resolveKeyFromCatalog([], "foo"), "foo");
  });

  test("null targetId → null", () => {
    assert.equal(resolveKeyFromCatalog(catalog, null), null);
  });
});

describe("isRetryableLoadError", () => {
  test("ok:true → false", () => {
    assert.equal(isRetryableLoadError({ ok: true, status: 200 }), false);
  });

  test("network error (status 0) → true", () => {
    assert.equal(isRetryableLoadError({ ok: false, status: 0 }), true);
  });

  test("5xx → true", () => {
    assert.equal(isRetryableLoadError({ ok: false, status: 500 }), true);
    assert.equal(isRetryableLoadError({ ok: false, status: 503 }), true);
  });

  test("408 / 429 → true", () => {
    assert.equal(isRetryableLoadError({ ok: false, status: 408 }), true);
    assert.equal(isRetryableLoadError({ ok: false, status: 429 }), true);
  });

  test("404 + not found 訊息 → false", () => {
    const res = { ok: false, status: 404, body: { error: { message: "model not found" } } };
    assert.equal(isRetryableLoadError(res), false);
  });

  test("404 + busy 訊息 → true", () => {
    const res = { ok: false, status: 404, body: { error: { message: "engine busy" } } };
    assert.equal(isRetryableLoadError(res), true);
  });

  test("400 無特殊訊息 → false", () => {
    assert.equal(isRetryableLoadError({ ok: false, status: 400, body: {} }), false);
  });
});

describe("httpErrorToString", () => {
  test("標準 LM Studio 錯誤格式 → 組合訊息", () => {
    const res = { ok: false, status: 500, body: { error: { message: "boom", type: "server", code: 1 } } };
    assert.equal(httpErrorToString(res), "boom | type: server | code: 1");
  });

  test("無 error 欄位 → HTTP status", () => {
    assert.equal(httpErrorToString({ ok: false, status: 404, body: {} }), "HTTP 404");
  });

  test("body undefined → HTTP status", () => {
    assert.equal(httpErrorToString({ ok: false, status: 500, body: undefined }), "HTTP 500");
  });
});

describe("listLoadedFromModels", () => {
  test("標準格式（model.key + loaded_instances[].id）", () => {
    const models = [
      { key: "qwen/qwen3.6-35b-a3b", loaded_instances: [{ id: "i1", config: {} }] },
    ];
    assert.deepEqual(listLoadedFromModels(models), [
      { instanceId: "i1", modelKey: "qwen/qwen3.6-35b-a3b", fullKey: "qwen/qwen3.6-35b-a3b" },
    ]);
  });

  test("舊格式（inst.model）", () => {
    const models = [{ key: "k", loaded_instances: [{ id: "i1", model: "legacy-model" }] }];
    assert.equal(listLoadedFromModels(models)[0].modelKey, "legacy-model");
  });

  test("舊格式（inst.config.model）", () => {
    const models = [{ key: "k", loaded_instances: [{ id: "i1", config: { model: "cfg-model" } }] }];
    assert.equal(listLoadedFromModels(models)[0].modelKey, "cfg-model");
  });

  test("display_name fallback", () => {
    const models = [{ key: "k", display_name: "Display", loaded_instances: [{ id: "i1" }] }];
    assert.equal(listLoadedFromModels(models)[0].modelKey, "k");
  });

  test("無 loaded_instances → 空陣列", () => {
    assert.deepEqual(listLoadedFromModels([{ key: "k" }]), []);
  });

  test("空陣列 → 空陣列", () => {
    assert.deepEqual(listLoadedFromModels([]), []);
  });
});

describe("normalizeBaseURL（H3/L5 修正）", () => {
  test("無尾綴 → 不變", () => {
    assert.equal(normalizeBaseURL("http://127.0.0.1:1234"), "http://127.0.0.1:1234");
  });

  test("尾綴 / → 移除", () => {
    assert.equal(normalizeBaseURL("http://127.0.0.1:1234/"), "http://127.0.0.1:1234");
  });

  test("尾綴 /v1 → 移除", () => {
    assert.equal(normalizeBaseURL("http://127.0.0.1:1234/v1"), "http://127.0.0.1:1234");
  });

  test("尾綴 /v1/ → 移除", () => {
    assert.equal(normalizeBaseURL("http://127.0.0.1:1234/v1/"), "http://127.0.0.1:1234");
  });

  test("null → null", () => {
    assert.equal(normalizeBaseURL(null), null);
  });

  test("空字串 → 空字串", () => {
    assert.equal(normalizeBaseURL(""), "");
  });
});

describe("isUnloadedMessage", () => {
  test("各種大小寫與標點", () => {
    assert.equal(isUnloadedMessage("Model is unloaded"), true);
    assert.equal(isUnloadedMessage("model is unloaded."), true);
    assert.equal(isUnloadedMessage("MODEL IS UNLOADED"), true);
  });

  test("其他訊息 → false", () => {
    assert.equal(isUnloadedMessage("connection refused"), false);
  });

  test("null → false", () => {
    assert.equal(isUnloadedMessage(null), false);
  });
});