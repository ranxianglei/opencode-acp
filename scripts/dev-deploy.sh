#!/usr/bin/env bash
#
# dev-deploy.sh — Build and deploy opencode-acp to the local opencode plugin cache.
#
# This is the canonical "one command" for local development:
#   1. Cleans dist/
#   2. Builds (tsup bundle + tsc declaration types)
#   3. Copies dist/ + package.json to the opencode plugin cache
#
# opencode resolves "opencode-acp@latest" to:
#   ~/.cache/opencode/packages/opencode-acp@latest/node_modules/opencode-acp/
#
# Usage:
#   ./scripts/dev-deploy.sh           # Build + deploy (default)
#   ./scripts/dev-deploy.sh --no-build # Deploy existing dist/ only
#   ./scripts/dev-deploy.sh --check    # Build + deploy + run tests first
#
# After deploying, restart opencode to load the new code.
#
set -euo pipefail

# ── Ensure node/npm are in PATH (detect common install locations) ──────────
shopt -s nullglob
if ! command -v npm &>/dev/null; then
    for candidate in \
        "$HOME/.local/share/fnm/aliases/default/bin" \
        "$HOME/.nvm/versions/node"/*/bin \
        "$HOME/.local/lib/node"*/bin \
        "$HOME/.volta/bin" \
        /usr/local/bin /usr/bin; do
        if [[ -x "$candidate/npm" ]] || [[ -x "$candidate/node" ]]; then
            export PATH="$candidate:$PATH"
            break
        fi
    done
fi
shopt -u nullglob

# ── Paths (all relative, no hardcoded user dirs) ───────────────────────────

# Project root = parent of scripts/ directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# opencode plugin cache (uses $HOME, works for any user)
DEPLOY_TARGET="$HOME/.cache/opencode/packages/opencode-acp@latest/node_modules/opencode-acp"

# Legacy resolution path. Older opencode versions resolve "opencode-acp@latest" to
# ~/.cache/opencode/node_modules/opencode-acp/ instead of the packages/@latest path.
# If this directory exists, keep it in sync so deploys take effect regardless of
# which resolution path the running opencode uses. (See AGENTS.md §3.4.)
LEGACY_TARGET="$HOME/.cache/opencode/node_modules/opencode-acp"

# ── Helpers ────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
step()  { echo -e "${CYAN}[STEP]${NC} $1"; }

# ── Pre-flight checks ─────────────────────────────────────────────────────

[[ -f "$PROJECT_ROOT/package.json" ]] || error "Not a valid project: missing package.json (looked in $PROJECT_ROOT)"

cd "$PROJECT_ROOT"

# Parse args
RUN_BUILD=true
RUN_TESTS=false
for arg in "$@"; do
    case "$arg" in
        --no-build) RUN_BUILD=false ;;
        --check)    RUN_TESTS=true ;;
        *)          error "Unknown argument: $arg\nUsage: $0 [--no-build|--check]" ;;
    esac
done

# ── Step 1: Tests (optional, --check) ─────────────────────────────────────

if [[ "$RUN_TESTS" == "true" ]]; then
    step "Running tests..."
    npm run test || error "Tests failed"
    info "Tests passed"
fi

# ── Step 2: Type check ────────────────────────────────────────────────────

if [[ "$RUN_BUILD" == "true" ]]; then
    step "Type checking..."
    npm run typecheck || error "Type check failed"
    info "Type check OK"
fi

# ── Step 3: Build ─────────────────────────────────────────────────────────

if [[ "$RUN_BUILD" == "true" ]]; then
    step "Building (tsup + tsc --emitDeclarationOnly)..."
    npm run build || error "Build failed"

    [[ -f "$PROJECT_ROOT/dist/index.js" ]] \
        || error "Build completed but dist/index.js not found"
    info "Build OK ($(du -h "$PROJECT_ROOT/dist/index.js" | cut -f1))"
else
    step "Skipping build (--no-build)"
    [[ -d "$PROJECT_ROOT/dist" ]] \
        || error "dist/ not found — run without --no-build first"
fi

# ── Step 4: Deploy ────────────────────────────────────────────────────────

step "Deploying to: $DEPLOY_TARGET"

if [[ ! -d "$DEPLOY_TARGET" ]]; then
    warn "Target directory doesn't exist. Creating..."
    mkdir -p "$DEPLOY_TARGET/dist"
fi

# Show version change
if [[ -f "$DEPLOY_TARGET/package.json" ]]; then
    OLD_VER=$(node -p "require('$DEPLOY_TARGET/package.json').version" 2>/dev/null || echo "?")
    info "Current deployed version: v$OLD_VER"
fi

NEW_VER=$(node -p "require('$PROJECT_ROOT/package.json').version" 2>/dev/null || echo "?")
info "Deploying version: v$NEW_VER"

# Copy dist/ and package.json
cp -r "$PROJECT_ROOT/dist/"* "$DEPLOY_TARGET/dist/"
cp "$PROJECT_ROOT/package.json" "$DEPLOY_TARGET/package.json"

# Verify
DEPLOYED_VER=$(node -p "require('$DEPLOY_TARGET/package.json').version" 2>/dev/null || echo "?")
[[ "$DEPLOYED_VER" == "$NEW_VER" ]] \
    || error "Version mismatch after deploy (expected $NEW_VER, got $DEPLOYED_VER)"

# Sync the legacy resolution path if it exists (see comment on LEGACY_TARGET).
if [[ -d "$LEGACY_TARGET/dist" ]]; then
    cp -r "$PROJECT_ROOT/dist/"* "$LEGACY_TARGET/dist/"
    cp "$PROJECT_ROOT/package.json" "$LEGACY_TARGET/package.json"
    LEGACY_VER=$(node -p "require('$LEGACY_TARGET/package.json').version" 2>/dev/null || echo "?")
    [[ "$LEGACY_VER" == "$NEW_VER" ]] \
        || warn "Legacy path synced but version mismatch (expected $NEW_VER, got $LEGACY_VER)"
    info "Legacy path also synced: $LEGACY_TARGET"
else
    info "No legacy install at $LEGACY_TARGET — skipping sync"
fi

# ── Done ──────────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}=========================================${NC}"
echo -e "${GREEN}  ✅ Deployed: v$DEPLOYED_VER${NC}"
echo -e "${GREEN}  Path: $DEPLOY_TARGET${NC}"
echo -e "${GREEN}=========================================${NC}"
echo ""
echo "⚠️  Restart opencode for changes to take effect."
echo ""
echo "Verify the deployed bundle has your changes:"
echo "  grep -c '<your-feature>' $DEPLOY_TARGET/dist/index.js"
echo ""
echo "ACP debug logs:"
echo "  ~/.config/opencode/logs/acp/context/<session_id>/"
echo "  ~/.config/opencode/logs/acp/daily/\$(date +%F).log"
