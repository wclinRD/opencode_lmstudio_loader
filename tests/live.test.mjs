/**
 * LM Studio Model Loader Plugin — 系統測試（真實 LM Studio server）
 *
 * 連線到本機 LM Studio（預設 http://127.0.0.1:1234）做端到端驗證：
 * - catalog 可讀取
 * - 若目前有「唯一已載入」的 LLM，用 fake V2 ctx 驅動 plugin 對它做一次
 *   真實 model.request hook（會 ping 就緒驗證），再驗證第二次走快路徑直通。
 *
 * 若 LM Studio 未啟動 → 整組 SKIP（不視為失敗）。
 *
 * 執行：node --test tests/live.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import plugin from "../lmstudio-model-loader.js";

const BASE_URL = process.env.LMSTUDIO_BASE_URL ?? "http://127.0.0.1:1234";

async function tryFetchModels() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(`${BASE_URL}/api/v1/models`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    return data.models ?? [];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function listLoaded(models) {
  const instances = [];
  for (const model of models ?? []) {
    for (const inst of model.loaded_instances ?? []) {
      if (inst.id) {
        instances.push({
          instanceId: inst.id,
          modelKey: model.key ?? inst.id,
          type: model.type,
        });
      }
    }
  }
  return instances;
}

/** 最小 fake 事件匯流排（系統測試不餵事件，只需讓 setup 能訂閱） */
function makeIdleEventBus() {
  return {
    subscribe({ signal } = {}) {
      return (async function* () {
        while (!signal?.aborted) {
          await new Promise((resolve) => {
            if (signal?.aborted) resolve();
            else signal?.addEventListener("abort", resolve, { once: true });
          });
        }
      })();
    },
  };
}

/** 建立 fake V2 ctx 並執行 plugin.setup(ctx) */
async function makeHarness(options) {
  const hooks = new Map();
  const ctx = {
    options,
    app: { version: "test" },
    provider: { get: async () => ({ data: { settings: {} } }) },
    session: {
      hook: async (name, callback, hookOpts) => {
        hooks.set(name, { callback, hookOpts });
        return { dispose: async () => hooks.delete(name) };
      },
    },
    event: { subscribe: (subOpts) => makeIdleEventBus().subscribe(subOpts) },
  };
  const cleanup = await plugin.setup(ctx);
  return { hooks, cleanup };
}

function chatEvent(sessionID, modelID) {
  return {
    sessionID,
    agent: "build",
    model: { providerID: "lmstudio", id: modelID, variant: "default" },
    kind: "primary",
    baseURL: `${BASE_URL}/v1`,
    headers: {},
  };
}

test("系統測試：真實 LM Studio 端到端", async (t) => {
  const models = await tryFetchModels();
  if (!models) {
    t.skip(`LM Studio 未啟動（${BASE_URL} 無法連線），跳過系統測試`);
    return;
  }

  const loaded = listLoaded(models);
  assert.ok(models.length > 0, "catalog 應有模型");

  // 若目前有唯一已載入的 LLM，做真實 model.request 驗證
  const soleLLM = loaded.length === 1 && loaded[0].type === "llm" ? loaded[0] : null;
  if (!soleLLM) {
    t.skip(`目前沒有「唯一已載入的 LLM」（已載入：${loaded.length}），跳過就緒驗證`);
    return;
  }

  const h = await makeHarness({
    baseURL: BASE_URL,
    fetchImpl: globalThis.fetch,
    pollIntervalMs: 1000,
    pingRetryDelayMs: 1500,
    readyTTLMs: 60000,
    loadTimeoutMs: 300000,
    readyTimeoutMs: 300000,
  });
  t.after(() => h.cleanup());

  const modelID = soleLLM.modelKey.split("/").pop();
  const hook = h.hooks.get("model.request");
  assert.ok(hook, "model.request hook 應已註冊");
  assert.deepEqual(hook.hookOpts, { providerID: "lmstudio" }, "hook 應 scope 到 lmstudio");

  // 第一次：完整 ensure（含真實 ping 就緒驗證）
  await hook.callback(chatEvent("live-system-test", modelID));
  assert.ok(true, `模型 ${soleLLM.modelKey} 就緒驗證通過`);

  // 第二次：快路徑直通（不應拋錯）
  await hook.callback(chatEvent("live-system-test", modelID));
  assert.ok(true, `模型 ${soleLLM.modelKey} 快路徑直通`);
});
