/**
 * LM Studio Model Loader Plugin — 功能測試（opencode V2 plugin API）
 *
 * 以 fake V2 ctx（session.hook / event.subscribe / provider.get / options）
 * 驅動 `export default { id, setup(ctx) }` plugin，搭配注入式 FakeLMStudio
 * （實作 LM Studio REST API 行為）驗證：
 * - 冷啟動 load → poll → ping 就緒驗證流程
 * - 快路徑直通（verified cache + instanceId + TTL）
 * - 並發不同 model 序列化（修復 "Model is unloaded" 主因）
 * - ping 偵測到 unloaded → nudge reload
 * - load transient 錯誤重試 / 硬失敗不重試
 * - event 訂閱（session.execution.failed）失效快取 + 背景預載
 * - retry hook 復原（decision 覆寫 / 上限不動 decision）
 * - async unload 完成 poll、embedding 跳過 ping、provider 過濾與 hook scope
 *
 * 執行：node --test tests/
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import plugin from "../lmstudio-model-loader.js";

// ─── Fake LM Studio server ────────────────────────────────────

function makeRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

class FakeLMStudio {
  /**
   * @param {{models: Array<object>, unloadDelayMs?: number}} cfg
   */
  constructor({ models, unloadDelayMs = 0 } = {}) {
    this.models = models; // [{key, display_name, type}]
    this.instances = new Map(); // instanceId -> {instanceId, modelKey, healthy}
    this.log = []; // {t, op, key?, instanceId?, snap: [instanceIds]}
    this.unloadDelayMs = unloadDelayMs;
    this.pendingUnloads = new Map();

    // 腳本旋鈕
    this.loadFailures = 0;
    this.loadFailStatus = 503;
    this.loadFailMessage = "engine busy";
    this.pingFailures = 0;
    this.pingFailStatus = 500;
    this.pingFailMessage = "Model is unloaded.";
    this.pingUnloaded = false;
  }

  catalog() {
    return {
      models: this.models.map((m) => ({
        ...m,
        loaded_instances: [...this.instances.values()]
          .filter((i) => i.modelKey === m.key)
          .map((i) => ({ id: i.instanceId, config: {} })),
      })),
    };
  }

  findModelKey(model) {
    const hit = this.models.find((m) => m.key === model);
    if (hit) return hit.key;
    const tail = this.models.find((m) => (m.key ?? "").split("/").pop() === model);
    if (tail) return tail.key;
    return model;
  }

  record(op, extra = {}) {
    this.log.push({ t: Date.now(), op, snap: [...this.instances.keys()], ...extra });
  }

  async fetch(url, init = {}) {
    const u = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;

    if (method === "GET" && u.pathname === "/api/v1/models") {
      this.record("catalog");
      return makeRes(200, this.catalog());
    }

    if (method === "POST" && u.pathname === "/api/v1/models/load") {
      const key = this.findModelKey(body.model);
      this.record("load", { key });
      if (this.loadFailures > 0) {
        this.loadFailures -= 1;
        return makeRes(this.loadFailStatus, {
          error: { message: this.loadFailMessage, type: "load_error", code: this.loadFailStatus },
        });
      }
      if (!this.instances.has(key)) {
        this.instances.set(key, { instanceId: key, modelKey: key, healthy: true });
      }
      return makeRes(200, { type: "llm", instance_id: key, status: "loaded" });
    }

    if (method === "POST" && u.pathname === "/api/v1/models/unload") {
      const instanceId = body.instance_id;
      this.record("unload", { instanceId });
      if (this.unloadDelayMs > 0) {
        // 模擬 async unload：延遲後才從 catalog 消失
        const t = setTimeout(() => {
          this.instances.delete(instanceId);
          this.pendingUnloads.delete(instanceId);
        }, this.unloadDelayMs);
        this.pendingUnloads.set(instanceId, t);
      } else {
        this.instances.delete(instanceId);
      }
      return makeRes(200, { instance_id: instanceId });
    }

    if (method === "POST" && u.pathname === "/v1/chat/completions") {
      const key = this.findModelKey(body.model);
      this.record("ping", { key });
      const inst = this.instances.get(key);
      if (!inst || this.pingUnloaded) {
        return makeRes(this.pingFailStatus, {
          error: { message: this.pingFailMessage, type: "unloaded", code: this.pingFailStatus },
        });
      }
      if (this.pingFailures > 0) {
        this.pingFailures -= 1;
        return makeRes(this.pingFailStatus, {
          error: { message: this.pingFailMessage, type: "unloaded", code: this.pingFailStatus },
        });
      }
      return makeRes(200, {
        choices: [{ message: { role: "assistant", content: "pong" }, finish_reason: "length" }],
      });
    }

    return makeRes(404, { error: { message: `unknown endpoint ${method} ${u.pathname}` } });
  }
}

// ─── 測試工具 ─────────────────────────────────────────────────

const MODEL_A = { key: "qwen/qwen3.6-35b-a3b", display_name: "Qwen3.6 35B A3B", type: "llm" };
const MODEL_B = {
  key: "qwen3.6-35b-a3b-fable-holo3.1-mlx",
  display_name: "Qwen3.6 35B A3B Fable Holo3.1",
  type: "llm",
};
const EMBED = { key: "text-embedding-nomic-embed-text-v1.5", display_name: "Nomic Embed", type: "embedding" };

const FAST_OPTS = {
  pollIntervalMs: 5,
  pingRetryDelayMs: 5,
  loadRetryBaseDelayMs: 5,
  unloadCompletionTimeoutMs: 2000,
  loadTimeoutMs: 5000,
  readyTimeoutMs: 5000,
  readyTTLMs: 60000,
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * fake ctx.event.subscribe：async iterable 事件匯流排。
 * push() 送入事件；plugin 的訂閱迴圈會被喚醒取走。
 */
function makeEventBus() {
  const queue = [];
  let notify = null;
  let ended = false;
  const wake = () => {
    const n = notify;
    notify = null;
    if (n) n();
  };
  return {
    push(ev) {
      queue.push(ev);
      wake();
    },
    end() {
      ended = true;
      wake();
    },
    subscribe({ signal } = {}) {
      return (async function* () {
        while (true) {
          if (signal?.aborted) return;
          if (queue.length > 0) {
            yield queue.shift();
            continue;
          }
          if (ended) return;
          await new Promise((resolve) => {
            notify = resolve;
            if (signal?.aborted) resolve();
            else signal?.addEventListener("abort", resolve, { once: true });
          });
        }
      })();
    },
  };
}

/**
 * 建立 fake V2 ctx 並執行 plugin.setup(ctx)。
 * 回傳 hooks（名稱 → {callback, hookOpts}）、事件匯流排與呼叫輔助函式。
 */
async function makeHarness(fake, extraOpts = {}) {
  const hooks = new Map();
  const bus = makeEventBus();
  const ctx = {
    options: { fetchImpl: fake.fetch.bind(fake), ...FAST_OPTS, ...extraOpts },
    app: { version: "test" },
    provider: { get: async () => ({ data: { settings: {} } }) },
    session: {
      hook: async (name, callback, hookOpts) => {
        hooks.set(name, { callback, hookOpts });
        return { dispose: async () => hooks.delete(name) };
      },
    },
    event: { subscribe: (subOpts) => bus.subscribe(subOpts) },
  };
  const cleanup = await plugin.setup(ctx);
  return {
    hooks,
    bus,
    cleanup,
    scopeOf(name) {
      return hooks.get(name)?.hookOpts;
    },
    /** 模擬一次 model.request hook 呼叫（V1 chat.params 的對應） */
    async chat(sessionID, modelID, providerID = "lmstudio") {
      const h = hooks.get("model.request");
      assert.ok(h, "model.request hook 應已註冊");
      return h.callback({
        sessionID,
        agent: "build",
        model: { providerID, id: modelID, variant: "default" },
        kind: "primary",
        baseURL: "http://127.0.0.1:1234/v1",
        headers: {},
      });
    },
    /** 送入事件匯流排並等待訂閱迴圈處理 */
    async fire(ev, waitMs = 20) {
      bus.push(ev);
      await sleep(waitMs);
    },
    /** 模擬一次 retry hook 呼叫，回傳 event（可檢查 decision） */
    async retry(sessionID, modelID, error, attempt, decision = { retry: true, delay: 1000 }) {
      const h = hooks.get("retry");
      assert.ok(h, "retry hook 應已註冊");
      const event = {
        sessionID,
        agent: "build",
        model: { providerID: "lmstudio", id: modelID, variant: "default" },
        error,
        attempt,
        decision,
      };
      await h.callback(event);
      return event;
    },
  };
}

function countOps(log, op) {
  return log.filter((e) => e.op === op).length;
}

function ops(log, op) {
  return log.filter((e) => e.op === op);
}

// ─── 測試 ─────────────────────────────────────────────────────

describe("lmstudio-model-loader", () => {
  test("hook 註冊：model.request / retry 皆 scope 到 lmstudio", async () => {
    const fake = new FakeLMStudio({ models: [MODEL_A] });
    const h = await makeHarness(fake);
    assert.deepEqual(h.scopeOf("model.request"), { providerID: "lmstudio" });
    assert.deepEqual(h.scopeOf("retry"), { providerID: "lmstudio" });
    h.cleanup();
  });

  test("冷啟動：load → poll → ping 就緒驗證 → 快取", async () => {
    const fake = new FakeLMStudio({ models: [MODEL_A] });
    const h = await makeHarness(fake);

    await h.chat("s1", "qwen3.6-35b-a3b");

    assert.equal(countOps(fake.log, "load"), 1, "應載入一次");
    assert.equal(countOps(fake.log, "ping"), 1, "應 ping 一次");
    assert.equal(countOps(fake.log, "unload"), 0, "冷啟動不應 unload");
    assert.ok(fake.instances.has(MODEL_A.key), "instance 應存在");
    h.cleanup();
  });

  test("快路徑：第二次呼叫零 load / ping", async () => {
    const fake = new FakeLMStudio({ models: [MODEL_A] });
    const h = await makeHarness(fake);

    await h.chat("s1", "qwen3.6-35b-a3b");
    const loadAfterFirst = countOps(fake.log, "load");
    const pingAfterFirst = countOps(fake.log, "ping");

    await h.chat("s1", "qwen3.6-35b-a3b");

    assert.equal(countOps(fake.log, "load"), loadAfterFirst, "快路徑不應再 load");
    assert.equal(countOps(fake.log, "ping"), pingAfterFirst, "快路徑不應再 ping");
    h.cleanup();
  });

  test("並發不同 model 序列化：不互踩、全程單一 instance", async () => {
    const fake = new FakeLMStudio({ models: [MODEL_A, MODEL_B] });
    const h = await makeHarness(fake);

    await Promise.all([
      h.chat("s1", "qwen3.6-35b-a3b"),
      h.chat("s2", "qwen3.6-35b-a3b-fable-holo3.1-mlx"),
    ]);

    // 全程任何時刻不得超過 1 個 instance
    for (const e of fake.log) {
      assert.ok(
        e.snap.length <= 1,
        `違反單一模型約束：op=${e.op} 時有 ${e.snap.length} 個 instance`
      );
    }

    // 順序：A load → A ping 成功 → A unload → B load → B ping 成功
    const order = fake.log.map((e) => e.op).filter((op) => op !== "catalog");
    const aLoad = order.indexOf("load");
    const aPing = order.indexOf("ping");
    const aUnload = order.indexOf("unload");
    const bLoad = order.lastIndexOf("load");
    const bPing = order.lastIndexOf("ping");
    assert.ok(aLoad >= 0 && aPing >= 0 && aUnload >= 0 && bLoad >= 0 && bPing >= 0);
    assert.ok(aLoad < aPing, "A 應先載入再 ping");
    assert.ok(aPing < aUnload, "A 的 ping 成功後才允許被 unload（關鍵：請求送出前模型必須就緒）");
    assert.ok(aUnload < bLoad, "B 應在 A 卸載後才載入");
    assert.ok(bLoad < bPing, "B 應先載入再 ping");
    h.cleanup();
  });

  test("ping 偵測到 Model is unloaded → nudge reload → 成功", async () => {
    const fake = new FakeLMStudio({ models: [MODEL_A] });
    fake.pingFailures = 1; // 第一次 ping 回 "Model is unloaded."
    const h = await makeHarness(fake);

    await h.chat("s1", "qwen3.6-35b-a3b");

    assert.ok(countOps(fake.log, "load") >= 2, "偵測到 unloaded 後應重新載入（nudge）");
    assert.ok(countOps(fake.log, "ping") >= 2, "ping 應重試");
    assert.ok(fake.instances.has(MODEL_A.key), "最終應載入成功");
    h.cleanup();
  });

  test("load transient 失敗（503）會退避重試", async () => {
    const fake = new FakeLMStudio({ models: [MODEL_A] });
    fake.loadFailures = 2; // 前兩次失敗，第三次成功
    const h = await makeHarness(fake, { maxLoadRetries: 3 });

    await h.chat("s1", "qwen3.6-35b-a3b");

    assert.equal(countOps(fake.log, "load"), 3, "應重試到成功");
    h.cleanup();
  });

  test("load 硬失敗（404 not found）不重試、拋出明確錯誤", async () => {
    const fake = new FakeLMStudio({ models: [MODEL_A] });
    fake.loadFailures = 5;
    fake.loadFailStatus = 404;
    fake.loadFailMessage = "model not found";
    const h = await makeHarness(fake, { maxLoadRetries: 3 });

    await assert.rejects(
      h.chat("s1", "qwen3.6-35b-a3b"),
      /LM Studio 載入失敗/
    );
    assert.equal(countOps(fake.log, "load"), 1, "硬失敗不應重試");
    h.cleanup();
  });

  test("event 訂閱：session.execution.failed 含 Model is unloaded → 失效快取 + 背景預載", async () => {
    const fake = new FakeLMStudio({ models: [MODEL_A] });
    const h = await makeHarness(fake);

    // 先建立 verified cache（model.request 會記錄 session→model）
    await h.chat("s1", "qwen3.6-35b-a3b");
    const loadBefore = countOps(fake.log, "load");
    const pingBefore = countOps(fake.log, "ping");

    // 餵入 V2 事件（payload 在 event.data，V2 無 session.error）
    await h.fire({
      type: "session.execution.failed",
      data: { sessionID: "s1", error: { type: "unknown", message: "Model is unloaded." } },
    });

    // 等背景預載（250ms debounce + ensure）完成
    await sleep(600);

    assert.equal(
      countOps(fake.log, "load"),
      loadBefore,
      "目標已是唯一載入，背景預載不應重複 load"
    );
    assert.ok(
      countOps(fake.log, "ping") > pingBefore,
      "背景預載應重新 ping 驗證"
    );

    // 背景預載成功後 cache 已恢復 → 下一次請求走快路徑（不再 ping）
    const pingAfterBg = countOps(fake.log, "ping");
    await h.chat("s1", "qwen3.6-35b-a3b");
    assert.equal(
      countOps(fake.log, "ping"),
      pingAfterBg,
      "cache 恢復後下一次請求應走快路徑"
    );
    h.cleanup();
  });

  test("event 訂閱：非 unloaded 錯誤 / 未追蹤 session / 雜訊事件不動作", async () => {
    const fake = new FakeLMStudio({ models: [MODEL_A] });
    const h = await makeHarness(fake);

    await h.chat("s1", "qwen3.6-35b-a3b");
    const loadBefore = countOps(fake.log, "load");

    // 錯誤訊息不含 unloaded → 不動作
    await h.fire({
      type: "session.execution.failed",
      data: { sessionID: "s1", error: { type: "provider.internal", message: "rate limited" } },
    });
    // 未追蹤的 session → 不動作
    await h.fire({
      type: "session.execution.failed",
      data: { sessionID: "unknown-session", error: { type: "unknown", message: "Model is unloaded." } },
    });
    // 非失敗事件 → 不動作
    await h.fire({ type: "session.step.started", data: { sessionID: "s1" } });

    await sleep(400);
    assert.equal(countOps(fake.log, "load"), loadBefore, "不應觸發任何重新載入");
    h.cleanup();
  });

  test("event 訂閱：session.deleted 清除記錄，後續 unloaded 不預載", async () => {
    const fake = new FakeLMStudio({ models: [MODEL_A] });
    const h = await makeHarness(fake);

    await h.chat("s1", "qwen3.6-35b-a3b");
    const pingBefore = countOps(fake.log, "ping");

    await h.fire({ type: "session.deleted", data: { sessionID: "s1" } });
    await h.fire({
      type: "session.execution.failed",
      data: { sessionID: "s1", error: { type: "unknown", message: "Model is unloaded." } },
    });

    await sleep(400);
    assert.equal(
      countOps(fake.log, "ping"),
      pingBefore,
      "session 刪除後不應再為它背景預載"
    );
    h.cleanup();
  });

  test("retry hook：復原成功 → 覆寫 decision 立即重試（delay 0）", async () => {
    const fake = new FakeLMStudio({ models: [MODEL_A] });
    const h = await makeHarness(fake);

    // 先正常載入並記錄 session→model
    await h.chat("s1", "qwen3.6-35b-a3b");
    const pingBefore = countOps(fake.log, "ping");

    const event = await h.retry(
      "s1",
      "qwen3.6-35b-a3b",
      { type: "provider.internal", message: "boom", status: 500 },
      2
    );

    assert.ok(countOps(fake.log, "ping") > pingBefore, "復原時應重新 ping 驗證");
    assert.deepEqual(event.decision, { retry: true, delay: 0 }, "復原成功應覆寫 decision");
    h.cleanup();
  });

  test("retry hook：attempt 超過 maxRecoveryAttempts → 不動 decision", async () => {
    const fake = new FakeLMStudio({ models: [MODEL_A] });
    const h = await makeHarness(fake, { maxRecoveryAttempts: 2 });

    await h.chat("s1", "qwen3.6-35b-a3b");
    const pingBefore = countOps(fake.log, "ping");

    const event = await h.retry(
      "s1",
      "qwen3.6-35b-a3b",
      { type: "provider.internal", message: "boom", status: 500 },
      3 // 超過上限（預設 2）
    );

    assert.equal(countOps(fake.log, "ping"), pingBefore, "超過上限不應再復原");
    assert.deepEqual(
      event.decision,
      { retry: true, delay: 1000 },
      "超過上限應沿用 opencode 預設 decision"
    );
    h.cleanup();
  });

  test("async unload：等卸載完成才載入新模型", async () => {
    const fake = new FakeLMStudio({ models: [MODEL_A, MODEL_B], unloadDelayMs: 60 });
    // 預先載入 A
    fake.instances.set(MODEL_A.key, { instanceId: MODEL_A.key, modelKey: MODEL_A.key, healthy: true });
    const h = await makeHarness(fake);

    await h.chat("s2", "qwen3.6-35b-a3b-fable-holo3.1-mlx");

    const unloadEntry = ops(fake.log, "unload")[0];
    const loadB = ops(fake.log, "load").find((e) => e.key === MODEL_B.key);
    assert.ok(unloadEntry, "應先 unload A");
    assert.ok(loadB, "應載入 B");
    assert.ok(
      !loadB.snap.includes(MODEL_A.key),
      "載入 B 時 A 必須已從 catalog 消失（等卸載完成）"
    );
    assert.ok(fake.instances.has(MODEL_B.key), "B 應載入成功");
    h.cleanup();
  });

  test("TTL 過期：重新驗證（ping）但不 unload", async () => {
    const fake = new FakeLMStudio({ models: [MODEL_A] });
    const h = await makeHarness(fake, { readyTTLMs: 30 });

    await h.chat("s1", "qwen3.6-35b-a3b");
    const pingAfterFirst = countOps(fake.log, "ping");

    await sleep(60); // 等 cache 過期

    await h.chat("s1", "qwen3.6-35b-a3b");
    assert.ok(countOps(fake.log, "ping") > pingAfterFirst, "TTL 過期應重新 ping 驗證");
    assert.equal(countOps(fake.log, "unload"), 0, "TTL 過期不應 unload");
    h.cleanup();
  });

  test("embedding 模型：載入但跳過 ping", async () => {
    const fake = new FakeLMStudio({ models: [EMBED] });
    const h = await makeHarness(fake);

    await h.chat("s1", "text-embedding-nomic-embed-text-v1.5");

    assert.equal(countOps(fake.log, "load"), 1, "應載入 embedding");
    assert.equal(countOps(fake.log, "ping"), 0, "embedding 不應 ping");
    h.cleanup();
  });

  test("provider 過濾：非 lmstudio 請求 / 缺 modelID 不動作", async () => {
    const fake = new FakeLMStudio({ models: [MODEL_A] });
    const h = await makeHarness(fake);

    await h.chat("s1", "qwen3.6-35b-a3b", "omlx");
    await h.chat("s1", undefined);

    assert.equal(fake.log.length, 0, "不應有任何 API 呼叫");
    h.cleanup();
  });
});
