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
| `09-nudge-refire-after-compress.json` | Multi-turn nudge→compress→growth→re-nudge→re-compress. Verifies minBlockCount ≥ 1 (full re-nudge cycle with baseline reset is in scenario 10 + unit tests), maxBlockCount ≤ 8 |
| `10-autonomous-nudge-refire.json` | Issue #176: Autonomous session (bash tool calls grow context) → first nudge→compress → continued growth → second nudge→second compress → verify minBlockCount ≥ 2, maxCompressCallsVisible ≤ 2 |
| `11-tier2-baseline-untouched-by-captures.json` | Issue #364: verify raw-message T1 captures (m-refs) do NOT touch lastTier2NudgeTokens — stays unset when T2 never fired. The #235 never-undefined invariant is locked by unit tests on the distill/conservative reset path |
| `12-consumed-call-hiding.json` | Bug #236 regression: T1 compresses auto-consume previous blocks → verify lastRequestCompressCalls=1 (consumed calls hidden from LLM) |

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
- `respond`: `"text"`, `"compress"`, `"nudge-compress"`, `"task"`, or `"tool"`, `"autonomous-nudge"`
- `auto`: `true` = triggered by tool result, no user message needed
- `range`: `"all"` (entire conversation) or `[startIdx, endIdx]` (0-indexed into mNNNNN refs)
- `retryOnReject`: if the compress is rejected by quality gate, retry with this config
- `ranges`: array for batch compress (multiple ranges in one call)
- `growthText`: for `nudge-compress`/`autonomous-nudge` — text emitted when no nudge detected (grows context until ACP injects nudge)
- `maxCompressCount`: for `autonomous-nudge` — stop after this many total compressions emitted (default: 2)
- `acpConfig`: optional — overrides the default `acp.jsonc` for this scenario (enables testing protection behavior)
- `verify.blockCount`: exact block count after scenario
- `verify.minBlockCount` / `verify.maxBlockCount`: inclusive bounds on block count
- `verify.activeBlockCount`: exact count of active (non-deactivated) blocks
- `verify.nudgeBaselineSet`: `true` = `lastPerMessageNudgeTokens` is set (not null/undefined)
- `verify.tier2BaselineSet`: `true` = `lastTier2NudgeTokens` is set (not null/undefined)
- `verify.compressedCount`: exact count of messages in `byMessageId` (compressed set)
- `verify.minCompressedCount` / `verify.maxCompressedCount`: inclusive bounds on compressed message count
- `verify.maxCompressCallsVisible`: upper bound on compress tool_use calls visible in any single LLM request
- `verify.lastRequestCompressCalls`: exact compress call count in the final LLM request
- `verify.maxNudgeCount`: upper bound on total nudge detections across all requests

### Known Limitations

1. **T2 distillation not tested**: The fake LLM always uses `parseMessageRefs` (mNNNNN refs), never block IDs (bNN refs). When ACP injects a `[Tier 2 Trigger]` nudge, the fake LLM responds with a T1 compress (message refs), not a T2 distillation (block IDs). Additionally, each T1 compress auto-consumes the previous block (via `search.ts` auto-detection), so only 1 active T1 block exists at any time — T2 never triggers (requires ≥2 active T1 blocks). To test T2 distillation, the fake LLM would need to: (a) compress non-overlapping ranges to accumulate ≥2 active blocks, and (b) parse bNN refs from T2 trigger text to emit proper T2 distillation calls.

2. **`detectNudge` cannot distinguish T1 from T2**: Both T1 and T2 nudges inject the same "efficiency nudge to compress early" phrase (because T2 sets `shouldInject=true`, triggering the same composition breakdown code path). To distinguish them, the fake LLM would need to parse `[Tier 2 Trigger]` or `[Tier 3 Trigger]` markers from the suffix message.
