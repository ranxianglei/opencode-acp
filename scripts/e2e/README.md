# ACP E2E Tests

End-to-end tests for ACP compression using a fake LLM server.

## Quick Start

```bash
# Build ACP + run all scenarios
./scripts/e2e/run-e2e.sh

# Run a single scenario
./scripts/e2e/run-e2e.sh scripts/e2e/scenarios/01-basic-compress.json

# Skip rebuild during iteration
SKIP_BUILD=1 ./scripts/e2e/run-e2e.sh
```

## Prerequisites

- `opencode` binary on PATH (or set `OPENCODE_BIN`)
- `bun` runtime on PATH (or set `BUN_BIN`)
- `node` on PATH (or set `NODE_BIN`)
- `curl` for health checks

## How It Works

```
run-e2e.sh
  ├── Build ACP (npm run build)
  ├── Configure opencode (HOME=/tmp/acp-e2e isolation)
  ├── Warm up opencode DB (first-run migration)
  └── For each scenario:
      ├── Start fake LLM server (bun fake-llm-server.ts)
      ├── Reset turn counter
      ├── Run N user turns (opencode run -c "message")
      ├── Read ACP state file
      └── Verify assertions (verify.ts)
```

### Isolation

Tests run with `HOME=/tmp/acp-e2e` to avoid touching the user's real opencode config,
database, or ACP state. The test home is wiped and recreated each run.

### Fake LLM

`fake-llm-server.ts` is a Bun HTTP server that:
- Responds to OpenAI `/v1/chat/completions` with SSE streaming
- Reads a JSON scenario file defining turn-by-turn responses
- Emits either text responses or `compress` tool_use calls
- Parses `<dcp-message-id>` tags from conversation to find compressible message refs
- Tracks turns via a file-based counter (persists across `opencode run` invocations)

### Turn Tracking

Each `opencode run` makes 2 LLM calls: one with tools (real turn) and one without
(title generation). The fake LLM ignores calls with `tools=0` and only increments
the turn counter for real conversation turns.

## Scenarios

| File | Description |
|------|-------------|
| `01-basic-compress.json` | 3 text turns → compress all → verify 1 block |
| `02-quality-reject.json` | Bad summary → quality gate rejects → verify 0 blocks |
| `03-quality-acknowledge.json` | Reject → retry with `acknowledgeRisk` → verify 1 block |
| `04-batch-compress.json` | 4 text turns → batch compress 3 ranges → verify 3 blocks |
| `05-subagent-compress.json` | Subagent session → compress → verify parent + child blocks |
| `06-nudge-triggered.json` | Text turns grow context → ACP auto-injects nudge → fake LLM detects nudge and compresses → verify block count + nudge baseline |
| `07-protection-filtered.json` | Production config (preserveRecentMessages:5) → compress all → verify protected messages excluded from compressed set (soft-filter, not hard-reject) |
| `08-nudge-with-protection.json` | Nudge→compress WITH protection enabled → verify compress succeeds despite protected zone, nudge baseline set, protected messages survived |
| `09-nudge-refire-after-compress.json` | Multi-turn regression: nudge→compress→growth→second nudge→second compress → verify minBlockCount ≥ 2 |
| `10-autonomous-nudge-refire.json` | Issue #176: Autonomous session (bash tool calls grow context) → first nudge→compress → continued growth → second nudge→second compress → verify minBlockCount ≥ 2 |

### Scenario Format

```json
{
  "name": "scenario-name",
  "description": "What this tests",
  "turns": [
    { "respond": "text", "text": "LLM response for turn 1" },
    { "respond": "text", "text": "LLM response for turn 2" },
    {
      "respond": "compress",
      "topic": "Topic",
      "summary": "Summary text",
      "range": "all",
      "retryOnReject": {
        "summary": "Better summary",
        "acknowledgeRisk": true
      }
    },
    { "respond": "text", "text": "Auto ack", "auto": true }
  ],
  "verify": {
    "blockCount": 1
  }
}
```

**Fields:**
- `respond`: `"text"`, `"compress"`, `"nudge-compress"`, `"task"`, or `"tool"`
- `auto`: `true` = triggered by tool result, no user message needed
- `range`: `"all"` (entire conversation) or `[startIdx, endIdx]` (0-indexed into mNNNNN refs)
- `retryOnReject`: if the compress is rejected by quality gate, retry with this config
- `ranges`: array for batch compress (multiple ranges in one call)
- `growthText`: for `nudge-compress` — text emitted when no nudge detected (grows context until ACP injects nudge)
- `acpConfig`: optional — overrides the default `acp.jsonc` for this scenario (enables testing protection behavior)
- `verify.blockCount`: exact block count after scenario
- `verify.minBlockCount`: minimum block count
- `verify.nudgeBaselineSet`: `true` = `lastPerMessageNudgeTokens` is set (not null/undefined)
- `verify.compressedCount`: exact count of messages in `byMessageId` (compressed set)
- `verify.minCompressedCount` / `verify.maxCompressedCount`: inclusive bounds on compressed message count
