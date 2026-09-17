# WORKLOG - V2 compaction usage becomes phantom system overhead (#421)

- Task ID: `2026-09-17_v2-compaction-phantom-system`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-09-17

## 1. Summary

- **What was done** (1–3 sentences): Guarded the system-overhead calibration against V2 native-compaction summaries (which carry the compaction request's own token usage verbatim), added a measured current-wire system-token floor fed by the V2 context handler, invalidated the cached estimate on native compaction and mid-session model switch, and surfaced heuristic-vs-measured provenance in `/acp context`.
- **Why** (1–3 sentences): After a V2 native compaction the first visible assistant is the checkpoint summary whose `tokens.input` is the compaction *request* size (repro: 653137). The old calibration stored 653136 tokens of permanent phantom system overhead, driving the hard-guard budget to −285904 on a 400000-token model and log spam / spurious tool clearing while actual provider usage was far smaller.
- **Behavior / compatibility changes**: Yes —
  - Calibration now subtracts the full wire-visible pre-anchor prefix (not just the first user text); plain-text sessions calibrate byte-for-byte as before (#255 suite stays green).
  - Compaction/checkpoint assistants (`info.summary === true`) and assistants created before `state.lastCompaction` are never calibration anchors.
  - Cached `systemPromptTokens` is cleared on native compaction and on model switch; previously it survived both.
  - `/acp context` breakdown now labels the system segment `[measured]` or `[estimated]`.
  - V1 behavior otherwise unchanged; no persisted-state format change (`systemPromptTokens` was already transient).
- **Risk level**: Medium (touches the shared transform pipeline used by V1 and V2; mitigated by 14 new regression tests incl. verified bug-catch, and the full 1400+ test suite staying green).

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| branch `2026-09-17_v2-compaction-phantom-system` (single feature commit on top of `1fe36e0`) | fix(v2): stop compaction usage from becoming phantom system overhead (#421) |

### Key Files

- `lib/token-utils.ts` — new `isCalibrationAnchor` / `calibrateSystemOverhead(state, messages)`; `estimateSystemPromptTokens(messages, lastCompaction = 0)` now delegates to it. Anchor guards: skip summary assistants and pre-`lastCompaction` assistants; prefix subtraction excludes host-ignored user parts and ACP-owned notices using real BPE counts.
- `lib/ui/utils.ts` — `cacheSystemPromptTokens(state, messages, measuredSystemTokens?)`: heuristic residual and measured wire value combined as `max(calibrated, measured)`; stores provenance in `state.systemPromptTokensSource`; keeps the [FIX #255] stable-positive-cache early return.
- `lib/state/types.ts`, `lib/state/state.ts`, `lib/state/transaction.ts` — new transient field `systemPromptTokensSource: "heuristic" | "measured" | undefined` (init/clear/snapshot/commit).
- `lib/state/utils.ts` — `resetOnCompaction` clears cached overhead + provenance so post-compaction history recalibrates cleanly (first-request-after-compaction and reload acceptance criteria).
- `lib/messages/transform.ts` — `MessageTransformOptions.measuredSystemTokens?: number` forwarded to the cache call; model-switch block also invalidates the cached overhead.
- `lib/hooks.ts` — `prepareMessageTransformTransaction(..., measuredSystemTokens?)` forwards the value through the shared pipeline (V1 callers omit it → `undefined`).
- `lib/v2/context.ts` — measures the actual outgoing system overhead (`Σ countTokens(event.system part.text)` + the ACP rendered system prompt) each transaction and passes it as the floor.
- `lib/compress/status.ts` — `/acp context` breakdown labels the system segment `[measured]` / `[estimated]`; fallback estimator passes `lastCompaction`.
- `tests/v2-compaction-system-overhead.test.ts` — 14 regression tests (new).
- `devlog/2026-09-17_v2-compaction-phantom-system/{REQ,DESIGN}.md` — ticket + design.

## 3. Design & Implementation Notes

- **Entry point / key function**: `calibrateSystemOverhead` (lib/token-utils.ts) is the single source of truth for the heuristic; `cacheSystemPromptTokens` (lib/ui/utils.ts) merges heuristic + measured; `runMessageTransform`'s model-switch block and `resetOnCompaction` are the two invalidation points.
- **Key configuration items**: none added (no config surface change).
- **Key logic explanation** (if non-trivial): see DESIGN.md §4–§5. The measured floor only comes from V2 (`event.system` is the host's actual outgoing system parts); V1 keeps the pure heuristic exactly as before.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck   # clean
npm test            # node --import tsx --test tests/*.test.ts
npm run build       # tsup + tsc --emitDeclarationOnly
npx prettier --write tests/v2-compaction-system-overhead.test.ts   # new file formatted
```

### Results

- New suite: `tests/v2-compaction-system-overhead.test.ts` — **14/14 pass**.
- Full suite: **1425 tests, 1424 pass, 1 fail** — the single failure is `tests/soft-block.test.ts` crashing at module load on `mkdir '/tmp/opencode-dcp-dangerous-…'` (EACCES): this sandbox mounts `/tmp` read-only (AGENTS.md 临时文件铁律). Pre-existing environmental incompatibility, unrelated to this change; the file passes in CI where `/tmp` is writable.
- **Bug-catch verification** (§5.7.3 discipline): with `lib/` stashed back to pre-fix code, a probe running the original `cacheSystemPromptTokens` on the exact #421 repro input (`[summary assistant input=653137 created=T, user "continue"]`) stored **653136** — the precise phantom reported in the issue — while the fixed code stores `undefined`. The regression tests fail against the buggy code by construction (they import the new guard functions and assert the non-phantom outcomes).
- Typecheck clean; build passes.

## 5. Review Fix (post-commit)

**Gap found in independent review**: `estimateContextComposition` (`lib/messages/inject/utils.ts`) has a live fallback for when `state.systemPromptTokens` is not yet cached — it called `estimateSystemPromptTokens(messages)` **without** `lastCompaction`. After `resetOnCompaction` invalidates the cache, a pre-compaction assistant (created before `state.lastCompaction`, carrying the large pre-compaction request usage) could become the calibration anchor again, resurfacing the stale overhead in nudge/context-usage math. The PR already applied this guard to the `/acp context` fallback in `lib/compress/status.ts`; the sibling path was missed.

**Fix**: pass `state?.lastCompaction ?? 0` through in `estimateContextComposition`.

**Regression test added**: `tests/v2-compaction-system-overhead.test.ts` test 15 — "estimateContextComposition: live fallback honors compaction boundary when cache empty". Uses a non-summary pre-compaction assistant (created < T, input=300_000) plus a post-compaction response calibrated to a known wire overhead (17_000). Verified to fail against the unfixed code (only test 15 fails) and pass with the fix.

**Re-verification after the fix**: new suite 15/15 pass; full suite 1426 tests, 1425 pass, 1 fail (same pre-existing environmental `tests/soft-block.test.ts` /tmp EACCES); typecheck clean; prettier clean on touched files.
