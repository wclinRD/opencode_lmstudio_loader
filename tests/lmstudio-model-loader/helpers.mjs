/**
 * 測試輔助：從 plugin 原始碼提取內部純函式。
 *
 * plugin 為了符合 opencode 的「只能有一個 export」限制，所有 helper 都是
 * module 內部函式。單元測試需要直接測試這些純函式，因此用「大括號配對」
 * 的方式從原始碼提取函式本體，再以 new Function 載入。
 *
 * 注意：僅適用於「自包含」的純函式（不依賴其他 module 內部函式或外部變數）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** plugin 原始檔絕對路徑 */
export const PLUGIN_PATH = path.resolve(__dirname, "../../plugins/lmstudio-model-loader.js");

/** plugin 原始碼 */
export const pluginSource = fs.readFileSync(PLUGIN_PATH, "utf8");

/**
 * 從原始碼提取指定名稱的函式本體（含 `function NAME(...) { ... }` 完整文字）。
 *
 * @param {string} src - 原始碼
 * @param {string} name - 函式名稱
 * @returns {string} 函式完整文字
 */
export function extractFunction(src, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`, "g");
  const m = re.exec(src);
  if (!m) throw new Error(`function ${name} not found in plugin source`);
  const openIdx = src.indexOf("{", m.index);
  if (openIdx === -1) throw new Error(`function ${name} has no body`);
  let depth = 0;
  let i = openIdx;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return src.slice(m.index, i + 1);
}

/**
 * 載入指定名稱的純函式（自包含，無外部依賴）。
 *
 * @param {string} name - 函式名稱
 * @returns {Function} 可呼叫的函式
 */
export function loadFunction(name) {
  const fnSrc = extractFunction(pluginSource, name);
  // eslint-disable-next-line no-new-func
  return new Function(`return (${fnSrc})`)();
}