#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PREPARE_SCRIPT="${SCRIPT_DIR}/prepare-build.sh"
REPO_URL="https://github.com/lhizzy0417/MyAgents.git"
REPO_PATH="/Users/hanako/Documents/New project 2/MyAgents-green"
UPSTREAM_URL="https://github.com/hAcKlyc/MyAgents.git"
APP_PATH="/Applications/MyAgents.app"
BACKUP_PATH="/Applications/MyAgents.app.backup-before-morandi"
LOG_PATH="${HOME}/Desktop/MyAgents-莫兰迪绿-安装日志.txt"
RELEASE_APP_PATH="${REPO_PATH}/src-tauri/target/release/bundle/macos/MyAgents.app"
RELEASE_TAR_PATH="${REPO_PATH}/src-tauri/target/release/bundle/macos/MyAgents.app.tar.gz"
LOCK_DIR="/tmp/myagents-morandi-green-build.lock"

if [[ ! -x "${PREPARE_SCRIPT}" ]]; then
  echo "缺少 prepare-build.sh"
  exit 1
fi

if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  echo "已经有一轮绿色补丁正在运行。"
  echo "请先看桌面日志是否已经出现“安装完成”，不要连续重复点。"
  read -k 1 "?按任意键关闭窗口…"
  exit 1
fi

cleanup() {
  rm -rf "${LOCK_DIR}"
}
trap cleanup EXIT

exec > >(tee "${LOG_PATH}") 2>&1

clear
echo "======================================"
echo "  MyAgents 莫兰迪绿补丁"
echo "======================================"
echo ""
echo "绿色源码仓库：${REPO_URL}"
echo "上游源码仓库：${UPSTREAM_URL}"
echo "本地绿色仓库：${REPO_PATH}"
echo "日志位置：${LOG_PATH}"
echo ""

if [[ ! -d "${REPO_PATH}/.git" ]]; then
  echo "找不到本地绿色仓库：${REPO_PATH}"
  exit 1
fi

cd "${REPO_PATH}"
git remote add upstream "${UPSTREAM_URL}" 2>/dev/null || git remote set-url upstream "${UPSTREAM_URL}"
git checkout main >/dev/null 2>&1 || true

echo "[1/7] 更新本地绿色仓库..."
set +e
git fetch origin main
FETCH_ORIGIN_STATUS=$?
set -e
if [[ ${FETCH_ORIGIN_STATUS} -eq 0 ]]; then
  git checkout -B main FETCH_HEAD
else
  echo "连接你的 GitHub 仓库失败，先继续使用本地已有版本。"
fi

echo "[2/7] 对齐原作者最新版..."
set +e
git fetch upstream main
FETCH_UPSTREAM_STATUS=$?
set -e
if [[ ${FETCH_UPSTREAM_STATUS} -eq 0 ]]; then
  git config user.name "Hanako Local Sync"
  git config user.email "hanako-local-sync@users.noreply.github.com"
  set +e
  git merge --no-edit upstream/main
  MERGE_STATUS=$?
  set -e
  if [[ ${MERGE_STATUS} -ne 0 ]]; then
    echo ""
    echo "上游合并失败，可能是原作者这次改动和绿色补丁发生了冲突。"
    echo "本次已停止，避免装进异常版本。"
    exit ${MERGE_STATUS}
  fi
else
  echo "连接原作者仓库失败，先继续使用本地已有版本。"
fi

echo "[3/7] 重新套用莫兰迪绿..."
node "${SCRIPT_DIR}/apply-theme.mjs" "${REPO_PATH}"
git add -A
if ! git diff --cached --quiet; then
  git commit -m "chore(sync): refresh morandi green from upstream" >/dev/null
fi

echo "[4/7] 回写到你的绿色仓库..."
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1 && [[ ${FETCH_ORIGIN_STATUS} -eq 0 ]]; then
  git push origin HEAD:main
else
  echo "本次不回写 GitHub，先只在本机安装绿色最新版。"
fi

echo "[5/7] 安装依赖..."
npm ci

echo "[6/7] 准备绿色主题和运行时..."
zsh "${PREPARE_SCRIPT}" "${REPO_PATH}"

echo "[7/7] 准备打包环境并生成 App..."
export NODE_OPTIONS=--max-old-space-size=12288
SOURCE_VERSION="$(node -e "const p=require('${REPO_PATH}/package.json'); process.stdout.write(p.version)")"
INSTALLED_VERSION=""
if [[ -f "${APP_PATH}/Contents/Info.plist" ]]; then
  INSTALLED_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "${APP_PATH}/Contents/Info.plist" 2>/dev/null || true)"
fi

echo "源码版本：${SOURCE_VERSION}"
if [[ -n "${INSTALLED_VERSION}" ]]; then
echo "当前已装版本：${INSTALLED_VERSION}"
fi
echo "清理旧打包产物..."
rm -rf "${RELEASE_APP_PATH}" "${RELEASE_TAR_PATH}"

echo "这一步可能会长时间停在 transforming...，属于正常现象。"
echo "只要不要重复再点第二次，等桌面日志继续往下走就行。"
set +e
npm run tauri:build -- --bundles app
BUILD_STATUS=$?
set -e

if [[ ${BUILD_STATUS} -ne 0 ]]; then
  if [[ ! -d "${RELEASE_APP_PATH}" ]]; then
    echo ""
    echo "打包失败，且没有发现可用的 MyAgents.app。"
    exit ${BUILD_STATUS}
  fi
  echo ""
  echo "打包阶段有提示，但本地 App 已生成，继续校验版本。"
fi

if [[ ! -d "${RELEASE_APP_PATH}" ]]; then
  echo "没有找到生成好的 App。"
  exit 1
fi

BUILT_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "${RELEASE_APP_PATH}/Contents/Info.plist")"
echo "生成版本：${BUILT_VERSION}"

if [[ "${BUILT_VERSION}" != "${SOURCE_VERSION}" ]]; then
  echo ""
  echo "版本校验失败：源码是 ${SOURCE_VERSION}，但生成包是 ${BUILT_VERSION}。"
  echo "为避免降级，已停止安装。"
  exit 1
fi

if [[ -n "${INSTALLED_VERSION}" ]]; then
  VERSION_CHECK="$(node - <<'NODE' "${INSTALLED_VERSION}" "${BUILT_VERSION}"
const [installed, built] = process.argv.slice(2);
function norm(v) {
  return String(v).split('.').map((x) => Number.parseInt(x, 10) || 0);
}
function cmp(a, b) {
  const aa = norm(a);
  const bb = norm(b);
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i += 1) {
    const av = aa[i] || 0;
    const bv = bb[i] || 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}
process.stdout.write(String(cmp(installed, built)));
NODE
)"
  if [[ "${VERSION_CHECK}" == "1" ]]; then
    echo ""
    echo "降级保护触发：当前已装版本 ${INSTALLED_VERSION} 高于生成版本 ${BUILT_VERSION}。"
    echo "为避免回退，已停止安装。"
    exit 1
  fi
fi

echo "[安装] 写入应用程序..."
if [[ -d "${APP_PATH}" ]]; then
  rm -rf "${BACKUP_PATH}"
  mv "${APP_PATH}" "${BACKUP_PATH}"
fi
rm -rf "${APP_PATH}"
ditto "${RELEASE_APP_PATH}" "${APP_PATH}"

echo "重新打开 MyAgents..."
osascript -e 'tell application "MyAgents" to quit' >/dev/null 2>&1 || true
sleep 1
open -a "${APP_PATH}"

echo ""
echo "安装完成。"
echo "以后你只要双击："
echo "${SCRIPT_DIR}/MyAgents莫兰迪绿补丁.app"
echo ""
echo "它会自动对齐原作者最新版、重新套用绿色、安装到你的电脑。"
echo "如果窗口长时间停在“打包 App”，再看桌面日志最后几行是否已经出现“安装完成”。"
echo ""
read -k 1 "?按任意键关闭窗口…"
