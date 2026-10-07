#!/bin/bash
#
# build_release.sh — LM Studio Model Loader Plugin 建置與發布
#
# 流程：
#   1. 語法檢查（node --check）
#   2. 執行單元/功能測試（node --test tests/）
#   3. 執行真實 LM Studio 系統測試（若 server 未啟動會自動 SKIP，不視為失敗）
#   4. 複製 plugin 到專案根目錄的 release/ 資料夾（不存在則自動建立）
#
# 用法：
#   ./build_release.sh            # 完整建置
#   SKIP_LIVE=1 ./build_release.sh  # 跳過真實 server 系統測試
#
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_SRC="$PROJECT_DIR/lmstudio-model-loader.js"
RELEASE_DIR="$PROJECT_DIR/release"
VERSION="$(node -p "require('$PROJECT_DIR/package.json').version")"
STAMP="$(date +%Y%m%d-%H%M%S)"

echo "==> [1/4] 語法檢查"
node --check "$PLUGIN_SRC"
echo "    語法 OK"

echo "==> [2/4] 單元/功能測試"
node --test "$PROJECT_DIR/tests/lmstudio-model-loader.test.mjs"
echo "    單元測試通過"

if [[ "${SKIP_LIVE:-0}" != "1" ]]; then
  echo "==> [3/4] 真實 LM Studio 系統測試（未啟動會自動 SKIP）"
  node --test "$PROJECT_DIR/tests/live.test.mjs" || {
    echo "    ⚠️ 系統測試失敗（請確認 LM Studio 已啟動且模型已載入）"
    exit 1
  }
else
  echo "==> [3/4] 跳過真實 server 系統測試（SKIP_LIVE=1）"
fi

echo "==> [4/4] 複製到 release/"
mkdir -p "$RELEASE_DIR"
cp "$PLUGIN_SRC" "$RELEASE_DIR/lmstudio-model-loader.js"
cp "$PROJECT_DIR/package.json" "$RELEASE_DIR/package.json"
cp "$PROJECT_DIR/README.md" "$RELEASE_DIR/README.md"
cp "$PROJECT_DIR/README_en.md" "$RELEASE_DIR/README_en.md"

cat > "$RELEASE_DIR/VERSION.txt" <<EOF
lmstudio-model-loader v${VERSION} (opencode V2 plugin API, requires opencode >= 2.0)
built: ${STAMP}
files:
  - lmstudio-model-loader.js  (opencode plugin，export default { id, setup })
  - package.json              (測試用，type: module)
  - README.md                 (使用說明，繁體中文)
  - README_en.md              (使用說明，English)

deploy (auto-discovery, default options):
  cp lmstudio-model-loader.js ~/.config/opencode/plugins/          # 全域
  cp lmstudio-model-loader.js <project>/.opencode/plugins/         # 專案

deploy (custom options): see README 方式二 — config "plugins"
  requires a DIRECTORY (package.json + index.js), not a .js file.
EOF

echo ""
echo "✅ 建置完成：$RELEASE_DIR"
echo "   版本：v${VERSION}（${STAMP}）"
echo ""
echo "   部署方式："
echo "     [自動探索] cp $RELEASE_DIR/lmstudio-model-loader.js ~/.config/opencode/plugins/"
echo "     [自訂選項] 目錄形式（package.json + index.js）+ 設定檔 plugins，詳見 README 方式二"
echo "     然後重啟 opencode 即可生效"