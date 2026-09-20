# WORKLOG - Quality-gate rejection: stop leaking internal details into model context

- Task ID: `2026-09-20_quality-rejection-no-leak`
- Home Repo: `opencode-acp`
- Branch: `2026-09-20_quality-rejection-no-leak`
- References: https://github.com/ranxianglei/opencode-acp/issues/444

## 1. Commits

| # | Hash  | Summary |
|---|-------|---------|
| 1 | TBD   | fix: keep quality-gate rejection concise — strip internal details, log full diagnostics (#444) |

## 2. Key Files & Changes

### `lib/compress/quality-gate/rejection.ts`
- Added `RejectionDiagnosticsLogger` structural interface (`warn(message, data?)`) so the
  module can emit diagnostics without a runtime dependency on the concrete `Logger` class
  and so tests can inject a plain mock without casting.
- Added `coreReason(reason)` sanitizer: cuts an algorithm-provided reason at the first
  `:` or `(`, stripping internal threshold/config detail that the external
  `context-compress-algorithms` package appends (e.g. `(threshold: 200 chars OR 0.5% retention)`).
- Rewrote the model-facing message. Removed:
  - `"Full compression rules are already in your system prompt."` (architecture leak)
  - `"…to bypass the quality gate on your next compress call."` (internal-bypass framing)
  - `Gate layer:` / `rougeF1:` / `top20Recall:` lines (algorithm-internal metrics)
  - the redundant `Ratio:` line and the "the gate re-evaluates automatically" clause
- Now emits the FULL diagnostic record (full reason incl. thresholds, layer, originalTokens,
  summaryChars, ratio, retentionPct, rougeF1, top20Recall) via `logger?.warn(...)` when a logger
  is supplied — i.e. detailed info goes to the ACP log, not the model context.
- `buildQualityRejectionError(plan, result, logger?)` — new optional third param; existing 2-arg
  callers are unaffected.
- Message length dropped from ~780 chars to ~430 chars for a representative L1 rejection.

### `lib/compress/range.ts`
- Passes `ctx.logger` as the third argument to `buildQualityRejectionError(...)` (the single
  throw site) so full diagnostics land in the ACP log.

### `tests/quality-gate-enforcement.test.ts`
- New fixture `buildLeakFixture()` mirroring the real algorithm-package reason shape.
- New tests:
  - `rejection keeps actionable info but drops internal details (#444)` — asserts presence of
    header markers / range / core reason / Retry / acknowledgeRisk AND absence of
    "system prompt", "bypass", "Gate layer", "rougeF1", "top20Recall", "(threshold:".
  - `coreReason strips colon- and parenthetical-carried threshold detail (#444)` — table-driven
    across L1 colon form, L2 parenthetical form, L2 colon form, and bare reason.
  - `full rejection diagnostics are written to the logger, not the message (#444)` — asserts one
    warn record carries full reason/layer/rougeF1/top20Recall while none appear in the message.
  - `buildQualityRejectionError works without a logger (optional param)` — no-throw guard.

## 3. Test Results

- `npm run typecheck`: PASS (clean).
- Target file `tests/quality-gate-enforcement.test.ts`: 19/19 PASS (was 15 before this change).
- Full suite `node --import tsx --test tests/*.test.ts`: **1294 pass / 2 fail**.
  - Both failures are PRE-EXISTING and ENVIRONMENTAL, unrelated to this change:
    - `tests/soft-block.test.ts` → `EACCES: permission denied, mkdir '/tmp/opencode-dcp-dangerous-*'`
    - `tests/inactive-block-decompress.test.ts` → same read-only `/tmp` cause
  - Proven pre-existing by stashing all three changed files and re-running on clean HEAD: the
    same 2 tests fail identically there. This sandbox mounts `/tmp` read-only; those tests create
    temp dirs under `/tmp`. Not introduced or fixed here (out of scope).
- Mutation verification (§5.7.3): temporarily restored the OLD buggy `rejection.ts`; the 3 leak
  assertions FAILED against it (no-leak, coreReason strip, diagnostics-to-logger), then restored
  the fix → all green. Confirms the regression tests genuinely catch the bug.

## 4. Lessons Learned

- The #397 fix removed the giant embedded rule block but left finer-grained leaks (architecture
  sentence, "bypass" framing, algorithm metrics, threshold config). "Concise enough" was not the
  bar — "no internals in model context" is. Distinguish *actionable* content from *diagnostic*
  content: the former stays in the tool result, the latter belongs in the ACP log.
- Keep E2E detection markers (`COMPRESSION REJECTED`, `QUALITY GATE FAILURE`) stable in the
  header — `scripts/e2e/fake-llm-server.ts` greps for them.
- Sanitize at display time rather than depending on the external algorithm package's `reason`
  string staying terse.
