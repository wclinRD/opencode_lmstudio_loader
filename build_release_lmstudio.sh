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
cp "${TEST_DIR}/"*.mjs "${RELEASE_DIR}/tests/lmstudio-model-loader/"

echo ""
echo "完成！Release 內容："
ls -la "${RELEASE_DIR}"