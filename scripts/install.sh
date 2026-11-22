#!/usr/bin/env bash
# Install or update Antigravity Context Inspector on macOS / Linux
# Usage: curl -fsSL https://raw.githubusercontent.com/sametozbalkan/antigravity-context-inspector/main/scripts/install.sh | bash

set -euo pipefail

REPO_URL="https://github.com/sametozbalkan/antigravity-context-inspector.git"
TAR_URL="https://github.com/sametozbalkan/antigravity-context-inspector/archive/refs/heads/main.tar.gz"
PLUGIN_DIR="${HOME}/.gemini/config/plugins/context-inspector"

if [ -d "${PLUGIN_DIR}/.git" ] && command -v git >/dev/null 2>&1; then
  echo "Updating Context Inspector via git pull..."
  git -C "${PLUGIN_DIR}" pull --ff-only
  echo "Updated! Toggle Context Inspector off and on in Antigravity Customizations to reload."
  exit 0
fi

mkdir -p "$(dirname "${PLUGIN_DIR}")"

if [ -d "${PLUGIN_DIR}" ]; then
  echo "Replacing existing installation at ${PLUGIN_DIR}..."
  rm -rf "${PLUGIN_DIR}"
fi

if command -v git >/dev/null 2>&1; then
  echo "Cloning into ${PLUGIN_DIR}..."
  git clone "${REPO_URL}" "${PLUGIN_DIR}"
else
  echo "git not found — downloading archive..."
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "${TMP_DIR}"' EXIT
  curl -fsSL "${TAR_URL}" | tar -xz -C "${TMP_DIR}"
  mv "${TMP_DIR}"/antigravity-context-inspector-* "${PLUGIN_DIR}"
fi

echo ""
echo "Installed Context Inspector!"
echo 'Next: Open Antigravity -> Customizations -> Installed, enable "Context Inspector", and open it from the side panel.'
