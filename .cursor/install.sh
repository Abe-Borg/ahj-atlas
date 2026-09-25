#!/usr/bin/env bash
# Idempotent dependency install for AHJ Atlas cloud-agent environments.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Ensure Node.js 24 (the version AHJ Atlas requires) is installed and default.
nvm install 24 >/dev/null
nvm alias default 24 >/dev/null

# shellcheck disable=SC1091
. "$REPO_ROOT/.cursor/node-env.sh"

echo "Using Node $(node --version) (npm $(npm --version))"

# Install pinned dependencies from the committed lockfile.
npm ci
