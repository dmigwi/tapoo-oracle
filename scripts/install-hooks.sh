#!/bin/sh
# Installs the repository git hooks into .git/hooks.
#
#   ./scripts/install-hooks.sh

set -e

HOOK_SOURCE="$(dirname "$0")/hooks/pre-commit"
HOOK_TARGET="$(git rev-parse --git-dir)/hooks/pre-commit"

if [ ! -f "$HOOK_SOURCE" ]; then
    echo "Cannot find $HOOK_SOURCE" >&2
    exit 1
fi

cp "$HOOK_SOURCE" "$HOOK_TARGET"
chmod +x "$HOOK_TARGET"

echo "Installed pre-commit hook at $HOOK_TARGET"

if ! command -v pnpm >/dev/null 2>&1; then
    echo ""
    echo "Warning: pnpm is not on your PATH, so the hook's lint and test steps will fail."
    echo "Enable it with: corepack enable pnpm"
fi
