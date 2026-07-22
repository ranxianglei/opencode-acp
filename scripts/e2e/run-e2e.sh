#!/usr/bin/env bash
#
# E2E test runner for ACP compression.
#
# Runs scenario-based end-to-end tests:
#   1. Builds ACP
#   2. Starts a fake LLM server
#   3. Configures opencode with fake provider + local ACP plugin
#   4. Runs scripted multi-turn conversations
#   5. Verifies ACP state files
#
# Uses HOME isolation (/tmp/acp-e2e) to avoid touching real config.
#
# Usage:
#   ./scripts/e2e/run-e2e.sh                     # run all scenarios
#   ./scripts/e2e/run-e2e.sh scripts/e2e/scenarios/01-basic-compress.json  # run one
#   SKIP_BUILD=1 ./scripts/e2e/run-e2e.sh        # skip npm build (for iteration)

set -euo pipefail

c_grn=$'\033[32m'; c_red=$'\033[31m'; c_ylw=$'\033[33m'; c_blu=$'\033[34m'; c_rst=$'\033[0m'
pass() { printf '%sPASS%s %s\n' "$c_grn" "$c_rst" "$*"; }
fail() { printf '%sFAIL%s %s\n' "$c_red" "$c_rst" "$*"; exit 1; }
info() { printf '%s…%s %s\n' "$c_ylw" "$c_rst" "$*" >&2; }
step() { printf '%s==>%s %s\n' "$c_blu" "$c_rst" "$*" >&2; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="$REPO_ROOT/scripts/e2e"
FAKE_HOME="/tmp/acp-e2e"
FAKE_LLM_PORT="${FAKE_LLM_PORT:-8400}"
OPENCODE_BIN="${OPENCODE_BIN:-$(which opencode)}"
BUN_BIN="${BUN_BIN:-$(which bun)}"
NODE_BIN="${NODE_BIN:-$(which node)}"

[[ -x "$OPENCODE_BIN" ]] || fail "opencode binary not found (set OPENCODE_BIN)"
[[ -x "$BUN_BIN" ]] || fail "bun binary not found (set BUN_BIN)"
[[ -x "$NODE_BIN" ]] || fail "node binary not found (set NODE_BIN)"

SCENARIOS=()
if [[ $# -gt 0 ]]; then
    SCENARIOS=("$@")
else
    for f in "$SCRIPT_DIR"/scenarios/*.json; do
        SCENARIOS+=("$f")
    done
fi

info "repo root: $REPO_ROOT"
info "fake home: $FAKE_HOME"
info "opencode:  $OPENCODE_BIN"
info "bun:       $BUN_BIN"
info "scenarios: ${#SCENARIOS[@]}"

FAKE_LLM_PID=""

cleanup() {
    if [[ -n "$FAKE_LLM_PID" ]] && kill -0 "$FAKE_LLM_PID" 2>/dev/null; then
        info "killing fake LLM (pid $FAKE_LLM_PID)"
        kill "$FAKE_LLM_PID" 2>/dev/null || true
        wait "$FAKE_LLM_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

if [[ -z "${SKIP_BUILD:-}" ]]; then
    step "build ACP"
    (cd "$REPO_ROOT" && npm run build 2>&1 | tail -3)
    pass "build complete"
fi

step "configure opencode (HOME=$FAKE_HOME)"

rm -rf "$FAKE_HOME"
mkdir -p "$FAKE_HOME/.config/opencode"

ACP_DIST="$REPO_ROOT/dist"
[[ -f "$ACP_DIST/index.js" ]] || fail "ACP dist not found at $ACP_DIST — run npm run build"

cat > "$FAKE_HOME/.config/opencode/opencode.json" <<OCJSON
{
  "\$schema": "https://opencode.ai/config.json",
  "plugin": ["$ACP_DIST"],
  "provider": {
    "fake": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Fake (E2E test)",
      "options": {
        "baseURL": "http://127.0.0.1:$FAKE_LLM_PORT/v1"
      },
      "models": {
        "fake-model": {
          "name": "Fake Model"
        }
      }
    }
  },
  "model": "fake/fake-model",
  "permission": {
    "compress": "allow",
    "acp_status": "allow"
  }
}
OCJSON

cat > "$FAKE_HOME/.config/opencode/acp.jsonc" <<'ACPJSON'
{
    "compress": {
        "minCompressRange": 0,
        "maxSummaryLengthHard": 20000
    },
    "qualityGate": {
        "enabled": true,
        "algorithm": "rouge-recall-v1"
    }
}
ACPJSON
pass "opencode config written"

step "warm up opencode DB (migration takes time on first run)"
HOME="$FAKE_HOME" timeout -s KILL 300 "$OPENCODE_BIN" session list </dev/null >/dev/null 2>&1 || true
pass "opencode warm-up done"

TOTAL_PASS=0
TOTAL_FAIL=0

for scenario in "${SCENARIOS[@]}"; do
    scenario_name=$(basename "$scenario" .json)
    step "scenario: $scenario_name"

    rm -rf "$FAKE_HOME/.local/share/opencode/storage/plugin/acp"
    rm -f "$FAKE_HOME/.local/share/opencode/opencode.db"
    HOME="$FAKE_HOME" timeout -s KILL 120 "$OPENCODE_BIN" session list </dev/null >/dev/null 2>&1 || true

    rm -f /tmp/acp-e2e-turn-counter

    info "starting fake LLM server"
    PORT="$FAKE_LLM_PORT" SCENARIO="$scenario" TURN_COUNTER=/tmp/acp-e2e-turn-counter "$BUN_BIN" run "$SCRIPT_DIR/fake-llm-server.ts" 2>/tmp/acp-e2e-fakellm.log &
    FAKE_LLM_PID=$!

    for i in $(seq 1 30); do
        if curl -sf "http://127.0.0.1:$FAKE_LLM_PORT/v1/models" >/dev/null 2>&1; then
            pass "fake LLM up (pid $FAKE_LLM_PID)"
            break
        fi
        sleep 0.5
        [[ $i -eq 30 ]] && {
            tail /tmp/acp-e2e-fakellm.log
            fail "fake LLM did not come up"
        }
    done

    scenario_json=$(cat "$scenario")
    user_turn_count=$(echo "$scenario_json" | "$NODE_BIN" -e "
        const s = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
        const userTurns = s.turns.filter(t => !t.auto).length;
        process.stdout.write(String(userTurns));
    ")
    info "user turns to run: $user_turn_count"

    info "running conversation turns"
    for i in $(seq 1 "$user_turn_count"); do
        msg="E2E test message $i for $scenario_name"
        info "  turn $i: opencode run"
        if [[ $i -eq 1 ]]; then
            HOME="$FAKE_HOME" timeout -s KILL 120 "$OPENCODE_BIN" run \
                --model fake/fake-model \
                --format json \
                "$msg" </dev/null > /tmp/acp-e2e-turn-$i.json 2>&1 || true
        else
            HOME="$FAKE_HOME" timeout -s KILL 120 "$OPENCODE_BIN" run \
                --model fake/fake-model \
                --format json \
                --continue \
                "$msg" </dev/null > /tmp/acp-e2e-turn-$i.json 2>&1 || true
        fi
        info "  turn $i events: $(wc -l < /tmp/acp-e2e-turn-$i.json)"
    done

    SESSION_ID=$(HOME="$FAKE_HOME" "$OPENCODE_BIN" session list --format json 2>/dev/null \
        | "$NODE_BIN" -e "
            const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
            const sessions = Array.isArray(data) ? data : (data.data || data.sessions || []);
            if (sessions.length === 0) { process.exit(1); }
            process.stdout.write(sessions[0].id || sessions[0].sessionID || '');
        " 2>/dev/null || echo "")

    if [[ -z "$SESSION_ID" ]]; then
        info "session list fallback: reading from DB"
        SESSION_ID=$(HOME="$FAKE_HOME" "$OPENCODE_BIN" session list 2>&1 | head -5)
        info "raw session list: $SESSION_ID"
        fail "could not determine session ID for $scenario_name"
    fi

    info "session: $SESSION_ID"
    STATE_FILE="$FAKE_HOME/.local/share/opencode/storage/plugin/acp/${SESSION_ID}.json"

    if [[ ! -f "$STATE_FILE" ]]; then
        info "ACP state file not found: $STATE_FILE"
        info "available state files:"
        ls -la "$FAKE_HOME/.local/share/opencode/storage/plugin/acp/" 2>&1 || echo "(directory empty or missing)"
        fail "no ACP state file produced"
    fi

    info "verifying state"
    if HOME="$FAKE_HOME" "$NODE_BIN" --import tsx "$SCRIPT_DIR/verify.ts" "$STATE_FILE" "$scenario"; then
        pass "scenario $scenario_name"
        ((TOTAL_PASS++)) || true
    else
        fail "scenario $scenario_name FAILED"
        ((TOTAL_FAIL++)) || true
    fi

    info "fake LLM log (last 10 lines):"
    tail -10 /tmp/acp-e2e-fakellm.log >&2 || true

    kill "$FAKE_LLM_PID" 2>/dev/null || true
    wait "$FAKE_LLM_PID" 2>/dev/null || true
    FAKE_LLM_PID=""
    sleep 0.5
done

echo
echo "====================================================="
echo "E2E RESULTS: ${c_grn}${TOTAL_PASS} passed${c_rst}, ${c_red}${TOTAL_FAIL} failed${c_rst}"
echo "====================================================="

if [[ "$TOTAL_FAIL" -gt 0 ]]; then
    exit 1
fi
exit 0
