#!/bin/bash
# install-local-mac.sh — 在 Apple Silicon Mac 上从源码构建并安装 AhaStudio。
set -euo pipefail

APP_NAME="AhaStudio"
TARGET_PATH="/Applications/${APP_NAME}.app"
ASSUME_YES=0

usage() {
  cat <<'EOF'
用法: bash scripts/install-local-mac.sh [选项]

用途:
  在 Apple Silicon (arm64) Mac 上从源码构建 AhaStudio 并安装到
  /Applications/AhaStudio.app。

前提条件:
  - macOS（Apple Silicon 芯片）
  - Node.js 22（主版本号必须恰好为 22）
  - 本仓库的完整源码（从仓库根目录运行本脚本即可）

选项:
  -y, --yes    已存在 /Applications/AhaStudio.app 时跳过覆盖确认
  -h, --help   输出本帮助并退出

流程:
  node 版本检查 -> npm ci -> 拉取 speaker 模型 -> 打包 Claude 默认配置
  -> npm run build -> electron-builder(--dir, 不签名) -> ditto 安装到 /Applications
EOF
}

# 参数解析
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    -y|--yes)
      ASSUME_YES=1
      shift
      ;;
    *)
      echo "错误: 未知选项 $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

# 切换到仓库根目录（无论从哪里调用）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}/.."

echo "==> 检查 Node.js 版本..."
if ! command -v node >/dev/null 2>&1; then
  echo "错误: 未找到 node。请先安装 Node.js 22（例如 https://nodejs.org 或 nvm）。" >&2
  exit 1
fi
NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
if [[ "${NODE_MAJOR}" != "22" ]]; then
  echo "错误: 本脚本要求 Node.js 主版本为 22，当前为 $(node -v)。" >&2
  echo "请切换到 node 22 后重试（例如: nvm use 22）。" >&2
  exit 1
fi
echo "    node $(node -v) OK"

echo "==> npm ci"
npm ci

echo "==> 拉取 speaker 模型..."
node scripts/fetch-speaker-model.mjs

echo "==> 打包 Claude 默认配置..."
node scripts/bundle-claude-defaults.mjs

echo "==> 构建 (vite + tsc)..."
npm run build

echo "==> electron-builder (--dir, 跳过签名)..."
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64 --dir --publish never

# 在常见输出路径中定位构建出的 .app
APP_BUNDLE=""
for candidate in \
  "release/mac-arm64/${APP_NAME}.app" \
  "release/${APP_NAME}.app" \
  "dist/mac-arm64/${APP_NAME}.app" \
  "dist/${APP_NAME}.app"; do
  if [[ -d "${candidate}" ]]; then
    APP_BUNDLE="${candidate}"
    break
  fi
done

if [[ -z "${APP_BUNDLE}" ]]; then
  echo "错误: 未找到构建产物 ${APP_NAME}.app（已检查 release/ 与 dist/ 下的常见路径）。" >&2
  exit 1
fi

VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo unknown)"
echo "==> 找到构建产物: ${APP_BUNDLE} (v${VERSION})"

# 已存在时交互确认覆盖
if [[ -d "${TARGET_PATH}" ]]; then
  if [[ "${ASSUME_YES}" -ne 1 ]]; then
    read -r -p "${TARGET_PATH} 已存在，是否覆盖? [y/N] " reply
    case "${reply}" in
      [yY]|[yY][eE][sS]) ;;
      *)
        echo "已取消安装。"
        exit 0
        ;;
    esac
  fi
  echo "==> 删除旧的 ${TARGET_PATH}"
  rm -rf "${TARGET_PATH}"
fi

echo "==> 用 ditto 安装到 ${TARGET_PATH}"
ditto "${APP_BUNDLE}" "${TARGET_PATH}"

echo ""
echo "✅ 安装完成: ${TARGET_PATH} (AhaStudio v${VERSION})"
echo "   可从启动台或 Spotlight 打开 AhaStudio。"
