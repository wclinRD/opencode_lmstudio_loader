#!/usr/bin/env bash
# ============================================================
# LM Studio Model Loader Plugin — build / release 腳本
#
# 1. 執行單元測試（純函式）
# 2. 執行系統測試（plugin hooks + mock fetch）
# 3. 複製 plugin 與測試到專案根目錄的 release 資料夾
#    （資料夾不存在時自動建立）
# ============================================================
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_DIR="${PROJECT_DIR}/release"
PLUGIN_SRC="${PROJECT_DIR}/plugins/lmstudio-model-loader.js"
TEST_DIR="${PROJECT_DIR}/tests/lmstudio-model-loader"

# 抑制 Node 對無 package.json type 的 ESM 重新解析警告（不影響功能）
export NODE_NO_WARNINGS=1

echo "==> [1/4] 執行單元測試"
node --test "${TEST_DIR}/unit.test.mjs"

echo "==> [2/4] 執行系統測試"
node --test "${TEST_DIR}/system.test.mjs"

echo "==> [3/4] 建立 release 資料夾（不存在時自動建立）"
mkdir -p "${RELEASE_DIR}/tests/lmstudio-model-loader"

echo "==> [4/4] 複製 plugin 與測試到 release"
cp "${PLUGIN_SRC}" "${RELEASE_DIR}/lmstudio-model-loader.js"
# 測試複製到 release 時重寫 plugin 路徑：release 副本位於 release/ 根目錄，
# 而 source 測試指向 plugins/。sed 將 "../../plugins/lmstudio-model-loader.js"
# 改為 "../../lmstudio-model-loader.js"（指向 release 內的 plugin 副本）。
for f in "${TEST_DIR}"/*.mjs; do
  sed 's|\.\./\.\./plugins/lmstudio-model-loader\.js|../../lmstudio-model-loader.js|' "$f" \
    > "${RELEASE_DIR}/tests/lmstudio-model-loader/$(basename "$f")"
done

echo ""
echo "完成！Release 內容："
ls -la "${RELEASE_DIR}"