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

# ── Step 4: Version guard ─────────────────────────────────────────────────
# Prevent npm from overwriting local deploys on restart. opencode resolves
# @latest against the npm registry; if the local cache version is older than
# npm's latest, opencode re-downloads and overwrites the deploy.

step "Checking version against npm registry..."

LOCAL_VER=$(node -p "require('$PROJECT_ROOT/package.json').version" 2>/dev/null || echo "?")
NPM_VER=$(npm view opencode-acp version 2>/dev/null || echo "")

if [[ -z "$NPM_VER" ]]; then
    warn "Could not reach npm registry — skipping version guard"
    DEPLOY_VER="$LOCAL_VER"
else
    DEPLOY_VER=$(node -e "
        const local = '$LOCAL_VER'.split('.').map(Number);
        const npm = '$NPM_VER'.split('.').map(Number);
        const localOlder = local[0] < npm[0]
            || (local[0] === npm[0] && local[1] < npm[1])
            || (local[0] === npm[0] && local[1] === npm[1] && local[2] <= npm[2]);
        if (localOlder) {
            console.log(npm[0] + '.' + npm[1] + '.' + (npm[2] + 1));
        } else {
            console.log('$LOCAL_VER');
        }
    ")
    if [[ "$DEPLOY_VER" != "$LOCAL_VER" ]]; then
        warn "Local v$LOCAL_VER <= npm v$NPM_VER → bumping deployed version to v$DEPLOY_VER"
    else
        info "Local v$LOCAL_VER > npm v$NPM_VER — no bump needed"
    fi
fi

# ── Step 5: Deploy ────────────────────────────────────────────────────────

step "Deploying to: $DEPLOY_TARGET"

if [[ ! -d "$DEPLOY_TARGET" ]]; then
    warn "Target directory doesn't exist. Creating..."
    mkdir -p "$DEPLOY_TARGET/dist"
fi

info "Deploying version: v$DEPLOY_VER"

# Copy dist/ and package.json
cp -r "$PROJECT_ROOT/dist/"* "$DEPLOY_TARGET/dist/"
cp "$PROJECT_ROOT/package.json" "$DEPLOY_TARGET/package.json"

# Patch version in deployed package.json if bumped (don't touch source tree)
if [[ "$DEPLOY_VER" != "$LOCAL_VER" ]]; then
    node -e "
        const fs = require('fs');
        const p = '$DEPLOY_TARGET/package.json';
        const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
        pkg.version = '$DEPLOY_VER';
        fs.writeFileSync(p, JSON.stringify(pkg, null, 4) + '\n');
    "
    info "Patched deployed version to v$DEPLOY_VER"
fi

# Verify
DEPLOYED_VER=$(node -p "require('$DEPLOY_TARGET/package.json').version" 2>/dev/null || echo "?")
[[ "$DEPLOYED_VER" == "$DEPLOY_VER" ]] \
    || error "Version mismatch after deploy (expected $DEPLOY_VER, got $DEPLOYED_VER)"

# Sync the legacy resolution path if it exists (see comment on LEGACY_TARGET).
if [[ -d "$LEGACY_TARGET/dist" ]]; then
    cp -r "$PROJECT_ROOT/dist/"* "$LEGACY_TARGET/dist/"
    cp "$PROJECT_ROOT/package.json" "$LEGACY_TARGET/package.json"
    if [[ "$DEPLOY_VER" != "$LOCAL_VER" ]]; then
        node -e "
            const fs = require('fs');
            const p = '$LEGACY_TARGET/package.json';
            const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
            pkg.version = '$DEPLOY_VER';
            fs.writeFileSync(p, JSON.stringify(pkg, null, 4) + '\n');
        "
    fi
    LEGACY_VER=$(node -p "require('$LEGACY_TARGET/package.json').version" 2>/dev/null || echo "?")
    [[ "$LEGACY_VER" == "$DEPLOY_VER" ]] \
        || warn "Legacy path synced but version mismatch (expected $DEPLOY_VER, got $LEGACY_VER)"
    info "Legacy path also synced: v$LEGACY_VER"
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
