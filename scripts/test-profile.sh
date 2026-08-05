#!/usr/bin/env bash
#
# test-profile.sh — seed / refresh the isolated opencode-test profile used to
# test the kernel-based opencode-acp.
#
# What it does:
#   1. Copies the STABLE opencode.json (keeps providers/auth, model, agent,
#      permission, compaction, etc. — so the test instance can actually talk to
#      the LLM via the same zhipuai-lb proxy).
#   2. Swaps the `plugin` spec: `opencode-acp@latest` → the kernel build's
#      local path (the dist/ in this worktree). Non-ACP plugins (e.g. awork) are
#      preserved.
#
# The kernel dist is self-contained (acp-kernel is inlined by tsup), so no
# npm install is needed — opencode loads dist/index.js in place, exactly like
# the awork plugin (referenced by path in the stable config).
#
# Usage:
#   ./scripts/test-profile.sh --seed      # create/refresh the test config
#   ./scripts/test-profile.sh --seed -v   # verbose (show resolved config)
#   ./scripts/test-profile.sh --status    # show test profile state + storage
#
# Then run:  opencode-test        (TUI)   or   opencode-test run "hi"   (headless)

set -euo pipefail

ROOT="${OPENCODE_TEST_ROOT:-$HOME/.opencode-test}"
STABLE_CONFIG="$HOME/.config/opencode/opencode.json"
KERNEL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_CONFIG_DIR="$ROOT/config/opencode"
TEST_CONFIG="$TEST_CONFIG_DIR/opencode.json"

case "${1:--seed}" in
  --status)
    echo "opencode-test profile root: $ROOT"
    echo "  config : $TEST_CONFIG $([ -f "$TEST_CONFIG" ] && echo '[present]' || echo '[MISSING — run --seed]')"
    echo "  data   : $ROOT/data/opencode"
    echo "  cache  : $ROOT/cache/opencode"
    echo "  db     : $ROOT/data/opencode/opencode-test.db"
    if [ -d "$ROOT/data/opencode/storage/plugin" ]; then
      echo "  plugin state dirs:"
      find "$ROOT/data/opencode/storage/plugin" -maxdepth 1 -mindepth 1 -printf '    %f\n' 2>/dev/null || true
    fi
    exit 0
    ;;

  --seed)
    [ -f "$STABLE_CONFIG" ] || { echo "stable config not found: $STABLE_CONFIG" >&2; exit 1; }
    [ -f "$KERNEL_DIR/dist/index.js" ] || {
      echo "kernel dist not built — run 'npm run build' in $KERNEL_DIR first" >&2; exit 1
    }
    mkdir -p "$TEST_CONFIG_DIR"

    node - "$STABLE_CONFIG" "$TEST_CONFIG" "$KERNEL_DIR" <<'NODE'
const fs = require("fs");
const [, , stable, out, kernelDir] = process.argv;
const c = JSON.parse(fs.readFileSync(stable, "utf8"));
// Swap the ACP plugin spec to the kernel build (local path), keep other plugins.
if (Array.isArray(c.plugin)) {
  c.plugin = c.plugin.map(p =>
    typeof p === "string" && p.startsWith("opencode-acp") ? kernelDir : p
  );
} else if (typeof c.plugin === "string" && c.plugin.startsWith("opencode-acp")) {
  c.plugin = kernelDir;
} else {
  c.plugin = [kernelDir];
}
fs.writeFileSync(out, JSON.stringify(c, null, 2) + "\n");
console.log("seeded config : " + out);
console.log("plugin spec   : " + JSON.stringify(c.plugin));
NODE

    # Rebuild the kernel dist into the worktree so the path plugin is current.
    echo
    echo ">> building kernel dist (tsup)…"
    (cd "$KERNEL_DIR" && npm run build >/dev/null 2>&1) && echo "   dist/index.js OK" || echo "   WARN: build failed — using existing dist"

    LOCAL_BIN="${HOME}/.local/bin"
    mkdir -p "$LOCAL_BIN"
    if [ ! -f "$LOCAL_BIN/opencode-test" ] || ! cmp -s "$KERNEL_DIR/scripts/opencode-test.sh" "$LOCAL_BIN/opencode-test"; then
      cp "$KERNEL_DIR/scripts/opencode-test.sh" "$LOCAL_BIN/opencode-test"
      chmod +x "$LOCAL_BIN/opencode-test"
      echo "   installed launcher → $LOCAL_BIN/opencode-test"
    fi

    echo
    echo "opencode-test profile ready."
    echo "  Run:  opencode-test                      # TUI"
    echo "        opencode-test run \"reply with OK\"   # headless smoke test"
    echo "  After a run, kernel ACP state appears at:"
    echo "        $ROOT/data/opencode/storage/plugin/acp-kernel/"
    exit 0
    ;;

  *)
    echo "usage: $0 [--seed|--status]" >&2
    exit 2
    ;;
esac
