# WORKLOG - E2E Test for ACP Compression

- Task ID: `2026-07-22_e2e-test`
- Created: 2026-07-22
- Status: Done

## Summary

Built scenario-based E2E test framework for ACP compression. 4 scenarios covering basic compress, quality gate reject, quality gate acknowledge retry, and batch compress. All pass against real opencode with a fake LLM server.

## Implementation

### Files Created

| File | Lines | Purpose |
|------|-------|---------|
| `scripts/e2e/fake-llm-server.ts` | ~510 | Bun SSE server, scenario-driven, emits text or compress tool_use |
| `scripts/e2e/run-e2e.sh` | ~180 | Orchestrator: build → config → run → verify |
| `scripts/e2e/verify.ts` | ~95 | ACP state file checker |
| `scripts/e2e/scenarios/01-basic-compress.json` | — | Basic compression test |
| `scripts/e2e/scenarios/02-quality-reject.json` | — | Quality gate rejection test |
| `scripts/e2e/scenarios/03-quality-acknowledge.json` | — | Quality gate acknowledge retry test |
| `scripts/e2e/scenarios/04-batch-compress.json` | — | Batch compression test |
| `scripts/e2e/README.md` | — | Usage guide |

No changes to existing code. All files are new under `scripts/e2e/`.

### Key Design Decisions

1. **HOME isolation** (`/tmp/acp-e2e`): Fresh opencode config + DB + ACP state per run. Zero collision with user's real environment. No Docker needed.

2. **File-based turn counter**: `opencode run` is a separate process each time. The fake LLM tracks turns via `/tmp/acp-e2e-turn-counter` file. Counter only increments on real conversation turns (tools > 0), not auxiliary calls (title generation with tools=0).

3. **retryOnReject mechanism**: Quality gate rejection + acknowledgeRisk retry must happen within the same opencode process (because `qualityGateRetryPending` is transient). The fake LLM detects quality gate rejection in tool results and automatically retries with `acknowledgeRisk: true`.

4. **Scenario JSON format**: Turn-by-turn LLM response definitions. Supports text, compress, batch compress, and auto-acknowledgment steps. `auto: true` marks steps triggered by tool results (no user message needed).

### Bugs Found & Fixed During Development

1. **System prompt ref parsing**: Fake LLM was parsing `<dcp-message-id>` tags from the system prompt text (which contains example refs like `m00175`). Fixed: skip `role: "system"` messages in `parseMessageRefs`.

2. **minCompressRange**: Default 5000 chars blocked compression of short test conversations. Fixed: set `compress.minCompressRange: 0` in test `acp.jsonc`.

3. **ACP config location**: ACP config goes in `~/.config/opencode/acp.jsonc`, NOT in `opencode.json`. Fixed: write separate config file.

4. **Auxiliary LLM calls**: opencode makes 2 LLM calls per `opencode run` (real turn + title generation). Title generation has `tools=0`. Fixed: skip requests with `tools.length === 0`.

5. **Transient qualityGateRetryPending**: Cannot verify from persisted state file (transient flag not saved to disk). Fixed: scenario 02 verifies `blockCount === 0` instead. Scenario 03 uses `retryOnReject` to test the acknowledge flow within a single process.

### Test Results

```
Scenario 01 (basic-compress):      PASS — 1 block created
Scenario 02 (quality-reject):      PASS — 0 blocks (quality gate rejected)
Scenario 03 (quality-acknowledge): PASS — 1 block (rejected then acknowledged)
Scenario 04 (batch-compress):      PASS — 3 blocks (batch compression)
```

- 817 existing unit tests: all pass (no regressions)
- Typecheck: clean
- Build: clean

### Verification Commands

```bash
./scripts/e2e/run-e2e.sh                                    # all scenarios
./scripts/e2e/run-e2e.sh scripts/e2e/scenarios/01-basic-compress.json  # single
SKIP_BUILD=1 ./scripts/e2e/run-e2e.sh                        # skip rebuild
```
