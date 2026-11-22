#!/usr/bin/env bash
# Install or update Antigravity Context Inspector on macOS / Linux
# Usage: curl -fsSL https://raw.githubusercontent.com/sametozbalkan/antigravity-context-inspector/main/scripts/install.sh | bash

set -euo pipefail

REPO_URL="https://github.com/sametozbalkan/antigravity-context-inspector.git"
TAR_URL="https://github.com/sametozbalkan/antigravity-context-inspector/archive/refs/heads/main.tar.gz"
PLUGIN_DIR="${HOME}/.gemini/config/plugins/context-inspector"
PARENT_DIR="$(dirname "${PLUGIN_DIR}")"

if [ -e "${PLUGIN_DIR}/.git" ] && command -v git >/dev/null 2>&1; then
  echo "Updating Context Inspector via git pull..."
  git -C "${PLUGIN_DIR}" pull --ff-only
  echo "Updated! Toggle Context Inspector off and on in Antigravity Customizations to reload."
  exit 0
fi

mkdir -p "${PARENT_DIR}"
STAGE_ROOT="$(mktemp -d "${PARENT_DIR}/.tmp-context-inspector.XXXXXX")"
trap 'rm -rf "${STAGE_ROOT}"' EXIT

if command -v git >/dev/null 2>&1; then
  echo "Cloning into ${PLUGIN_DIR}..."
  STAGE_SRC="${STAGE_ROOT}/repo"
  git clone "${REPO_URL}" "${STAGE_SRC}"
else
  echo "git not found — downloading archive..."
  EXTRACT_DIR="${STAGE_ROOT}/extract"
  mkdir -p "${EXTRACT_DIR}"
  curl --proto '=https' --tlsv1.2 -fsSL "${TAR_URL}" | tar -xz -C "${EXTRACT_DIR}"
  shopt -s nullglob
  CANDIDATES=("${EXTRACT_DIR}"/*/)
  shopt -u nullglob
  if [ "${#CANDIDATES[@]}" -ne 1 ]; then
    echo "Error: expected a single extracted directory, found ${#CANDIDATES[@]}." >&2
    exit 1
  fi
  STAGE_SRC="${CANDIDATES[0]%/}"
fi

if [ ! -f "${STAGE_SRC}/plugin.json" ]; then
  echo "Error: staged installation is missing plugin.json." >&2
  exit 1
fi

if [ -e "${PLUGIN_DIR}" ] || [ -L "${PLUGIN_DIR}" ]; then
  echo "Replacing existing installation at ${PLUGIN_DIR}..."
  rm -rf "${PLUGIN_DIR}"
fi

mv "${STAGE_SRC}" "${PLUGIN_DIR}"

echo ""
echo "Installed Context Inspector!"
echo 'Next: Open Antigravity -> Customizations -> Installed, enable "Context Inspector", and open it from the side panel.'
