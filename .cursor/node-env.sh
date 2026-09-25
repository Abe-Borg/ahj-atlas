# Shared Node.js 24 activation for AHJ Atlas cloud-agent commands.
# Source this file (do not execute it) so PATH changes affect the caller.
#
# AHJ Atlas requires Node.js 24+ (see package.json "engines"). The base image's
# default `node` (and the exec-daemon `node` that is prepended to PATH) is older,
# so `nvm use` alone is not enough: we must prepend the resolved Node 24 bin dir
# to PATH so it wins over any earlier entries.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

if command -v nvm >/dev/null 2>&1; then
  NODE24_BIN="$(dirname "$(nvm which 24 2>/dev/null)" 2>/dev/null || true)"
  if [ -n "$NODE24_BIN" ] && [ -x "$NODE24_BIN/node" ]; then
    export PATH="$NODE24_BIN:$PATH"
  fi
fi
