#!/bin/zsh
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: scripts/myagents-morandi/prepare-build.sh /path/to/MyAgents"
  exit 1
fi

REPO_ROOT="$(cd "$1" && pwd)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_ARCH="$(uname -m)"

if [[ "${HOST_ARCH}" == "arm64" ]]; then
  NODE_CPU="arm64"
  SDK_TRIPLE="darwin-arm64"
else
  NODE_CPU="x64"
  SDK_TRIPLE="darwin-x64"
fi

node "${SCRIPT_DIR}/apply-theme.mjs" "${REPO_ROOT}"

mkdir -p "${REPO_ROOT}/src-tauri/binaries"

LATEST_JSON="$(curl -fsSL https://download.myagents.io/cuse/latest.json)"
VERSION="$(echo "${LATEST_JSON}" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
ARCHIVE_URL="$(echo "${LATEST_JSON}" | sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*macos-universal[^"]*\)".*/\1/p' | head -1)"
SHA_EXPECTED="$(echo "${LATEST_JSON}" | sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"

if [[ -z "${VERSION}" || -z "${ARCHIVE_URL}" || -z "${SHA_EXPECTED}" ]]; then
  echo "Failed to parse cuse metadata."
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

ARCHIVE_PATH="${TMP_DIR}/cuse.tar.gz"
curl -fsSL -o "${ARCHIVE_PATH}" "${ARCHIVE_URL}"
SHA_ACTUAL="$(shasum -a 256 "${ARCHIVE_PATH}" | awk '{print $1}')"
if [[ "${SHA_ACTUAL}" != "${SHA_EXPECTED}" ]]; then
  echo "cuse checksum mismatch."
  exit 1
fi

tar -xzf "${ARCHIVE_PATH}" -C "${TMP_DIR}"
cp "${TMP_DIR}/cuse" "${REPO_ROOT}/src-tauri/binaries/cuse-aarch64-apple-darwin"
cp "${TMP_DIR}/cuse" "${REPO_ROOT}/src-tauri/binaries/cuse-x86_64-apple-darwin"
chmod +x "${REPO_ROOT}/src-tauri/binaries/cuse-aarch64-apple-darwin" "${REPO_ROOT}/src-tauri/binaries/cuse-x86_64-apple-darwin"
echo "${VERSION}" > "${REPO_ROOT}/src-tauri/binaries/.cuse-version"

# Bundle Node.js runtime required by modern MyAgents desktop builds.
"${REPO_ROOT}/scripts/download_nodejs.sh" --target "${NODE_CPU}"

# Bundle tsx runtime so Plugin Bridge can execute TS-based plugins.
(cd "${REPO_ROOT}" && node scripts/setup-tsx-runtime.mjs darwin "${NODE_CPU}")

# Bundle sharp runtime expected by tauri.conf.json resources.
SHARP_DIR="${REPO_ROOT}/src-tauri/resources/sharp-runtime"
rm -rf "${SHARP_DIR}"
mkdir -p "${SHARP_DIR}"
cat > "${SHARP_DIR}/package.json" <<'SHARP_PKG'
{
  "name": "sharp-runtime",
  "private": true,
  "version": "1.0.0",
  "dependencies": { "sharp": "0.34.5" }
}
SHARP_PKG
(cd "${SHARP_DIR}" && npm install --no-audit --no-fund --no-save --ignore-scripts)

# Bundle the current-host Claude SDK native binary for local macOS builds.
SDK_DEST="${REPO_ROOT}/src-tauri/resources/claude-agent-sdk"
rm -rf "${SDK_DEST}"
mkdir -p "${SDK_DEST}"
SDK_SRC="${REPO_ROOT}/node_modules/@anthropic-ai/claude-agent-sdk-${SDK_TRIPLE}/claude"
if [[ ! -f "${SDK_SRC}" ]]; then
  echo "Missing Claude SDK binary: ${SDK_SRC}"
  exit 1
fi
cp "${SDK_SRC}" "${SDK_DEST}/claude"
chmod +x "${SDK_DEST}/claude"

if [[ ! -d "${REPO_ROOT}/mino" && -d "${HOME}/.myagents/projects/mino" ]]; then
  cp -R "${HOME}/.myagents/projects/mino" "${REPO_ROOT}/mino"
fi

echo "Prepared ${REPO_ROOT}"
