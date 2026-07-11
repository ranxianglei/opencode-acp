#!/usr/bin/env bash
# PR validation script — enforces AGENTS.md contributing standards.
#
# Checks:
#   1. Branch name matches YYYY-MM-DD_short-title
#   2. devlog/{branch-name}/REQ.md exists
#   3. devlog/{branch-name}/WORKLOG.md exists
#   4. If package.json version changed, README.md or README.zh-CN.md
#      must be modified AND contain the new version in changelog
#
# Usage: ./scripts/ci/check-pr.sh [branch-name] [base-branch]
#   branch-name defaults to $GITHUB_HEAD_REF or current branch
#   base-branch defaults to "origin/master"

set -euo pipefail

BRANCH="${1:-${GITHUB_HEAD_REF:-$(git branch --show-current)}}"
BASE="${2:-origin/master}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

errors=0
warn() { echo -e "${YELLOW}⚠ $1${NC}"; }
fail() { echo -e "${RED}✗ $1${NC}"; errors=$((errors + 1)); }
pass() { echo -e "${GREEN}✓ $1${NC}"; }

echo "=== PR Validation ==="
echo "Branch: $BRANCH"
echo "Base:   $BASE"
echo ""

# ── Check 1: Branch name convention ──────────────────────────
echo "── Branch name convention ──"
if echo "$BRANCH" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}_[a-z0-9.-]+$'; then
    pass "Branch name matches YYYY-MM-DD_short-title"
else
    fail "Branch name '$BRANCH' does not match YYYY-MM-DD_short-title (e.g., 2026-07-11_compress-baseline-fix)"
    echo "  Required format: digits-digits-digits_lowercase-kebab-case"
fi
echo ""

# ── Check 2 & 3: Devlog exists ───────────────────────────────
echo "── Devlog entry ──"
DEVLOG_DIR="devlog/$BRANCH"
if [ -f "$DEVLOG_DIR/REQ.md" ]; then
    pass "devlog/$BRANCH/REQ.md exists"
else
    fail "devlog/$BRANCH/REQ.md is missing (required by AGENTS.md Section 5.1.2)"
fi

if [ -f "$DEVLOG_DIR/WORKLOG.md" ]; then
    pass "devlog/$BRANCH/WORKLOG.md exists"
else
    fail "devlog/$BRANCH/WORKLOG.md is missing (required by AGENTS.md Section 5.1.2)"
fi
echo ""

# ── Check 4: Changelog updated when version changes ──────────
echo "── Changelog check ──"
# Get version from current branch's package.json
CURRENT_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "")
# Get version from base branch
BASE_VERSION=$(git show "$BASE:package.json" 2>/dev/null | node -e "
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
    try { console.log(JSON.parse(Buffer.concat(chunks).toString()).version); }
    catch { console.log(''); }
});
" 2>/dev/null || echo "")

if [ -z "$CURRENT_VERSION" ]; then
    warn "Could not read version from package.json — skipping changelog check"
elif [ -z "$BASE_VERSION" ]; then
    warn "Could not read version from $BASE — skipping changelog check"
elif [ "$CURRENT_VERSION" = "$BASE_VERSION" ]; then
    pass "Version unchanged ($CURRENT_VERSION) — changelog check skipped"
else
    echo "  Version change: $BASE_VERSION → $CURRENT_VERSION"

    # Check if README.md or README.zh-CN.md was modified
    README_CHANGED=$(git diff --name-only "$BASE"...HEAD -- README.md README.zh-CN.md 2>/dev/null | wc -l)

    if [ "$README_CHANGED" -eq 0 ]; then
        fail "Version bumped ($BASE_VERSION → $CURRENT_VERSION) but no README changelog update found"
        echo "  AGENTS.md requires changelog entries in README.md and README.zh-CN.md for version changes"
    else
        pass "README files modified — checking version string..."

        # Check that the new version appears in the changelog
        if grep -q "v${CURRENT_VERSION}\|### v${CURRENT_VERSION}" README.md 2>/dev/null; then
            pass "README.md changelog contains v$CURRENT_VERSION"
        else
            fail "README.md changelog does not contain '### v$CURRENT_VERSION'"
        fi

        if grep -q "v${CURRENT_VERSION}\|### v${CURRENT_VERSION}" README.zh-CN.md 2>/dev/null; then
            pass "README.zh-CN.md changelog contains v$CURRENT_VERSION"
        else
            fail "README.zh-CN.md changelog does not contain '### v$CURRENT_VERSION'"
        fi
    fi
fi
echo ""

# ── Summary ──────────────────────────────────────────────────
echo "=== Summary ==="
if [ "$errors" -eq 0 ]; then
    echo -e "${GREEN}All checks passed ✓${NC}"
    exit 0
else
    echo -e "${RED}$errors check(s) failed${NC}"
    exit 1
fi
