# WORKLOG - Visible Range Guidance & Compression Failure Recovery

- Task ID: `2026-07-05_visible-range-guidance`
- Home Repo: `opencode-acp`
- Status: InProgress
- Updated: 2026-07-05 21:10

## 1. Summary

- **What was done** (1–3 sentences): Rewrote the system prompt to list all four
  context tools with when-to-use hints and explicit compress / do-not-compress
  scenes; switched nudge cadence from "15% floor + 5% growth" to pure 5% growth
  with first-turn baseline; upgraded `acp_status` with `mode`/`sort`/`limit`
  args and per-block size + ID-range display; enriched `compress` boundary
  failures with the current visible range and an `acp_status` pointer.
- **Why** (1–3 sentences): The model repeatedly tried to compress IDs already
  consumed by prior blocks because it had no visibility into what remained
  compressible. Failure errors gave no recovery info, wasting turns.
- **Behavior / compatibility changes**: Yes — nudge frequency changes (more
  frequent at low context usage on large models); `acp_status` output format
  expands; system prompt text fully replaced.
- **Risk level**: Medium (prompt-behavior changes; mitigated by per-block
  commits and deferred nudge-text rewrite).

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| _(pending)_ | Block A: rewrite system prompt — 4 tools, scenes, drop "promptly" |
| _(pending)_ | Block C: drop 15% nudge floor, first-turn baseline |
| _(pending)_ | Block D: acp_status mode/sort/limit + sizes + ID ranges |
| _(pending)_ | Block E: enrich compress boundary failure error |
| _(pending)_ | Tests: cover all four blocks |

### Key Files

- `lib/prompts/system.ts` — full rewrite of system prompt body.
- `lib/messages/inject/utils.ts` — `computeShouldNudge` logic.
- `lib/messages/inject/inject.ts` — first-turn baseline establishment.
- `lib/compress/status.ts` — `acp_status` multi-mode/sort/limit + ranges.
- `lib/compress/search.ts` — enriched failure error.
- `tests/prompts.test.ts` — adjusted for new system prompt content.
- `tests/inject-utils-pure.test.ts` — rewritten for new nudge cadence.
- `tests/acp-status.test.ts` — extended for new modes/fields.
- `tests/compress-search.test.ts` — extended for enriched error.

## 3. Design & Implementation Notes

- **Entry point / key function**:
  - `computeShouldNudge` returns `shouldNudge: false` when
    `lastNudgeTokens === undefined` (first observed turn). Caller in
    `inject.ts` then sets `lastPerMessageNudgeTokens = currentTokens` to
    establish the baseline; subsequent turns use pure 5% growth logic.
- **Key configuration items**:
  - `minNudgeContextPercent` config field is preserved for backward
    compatibility but is now ignored by `computeShouldNudge`.
- **Key logic explanation** (if non-trivial):
  - `acp_status` `summary` mode shows each block's `compressedTokens→summaryTokens`
    and the `mNNNNN` range it consumed (derived from `directMessageIds`
    mapped through `state.messageIds.byRawId`). `detailed` mode adds
    `survivedCount`, `generation`, effective message count, and consumed block
    lineage.
  - `resolveBoundaryIds` failure path computes the visible range inline from
    the `SearchContext`'s raw messages and the state's `byRawId` map, without
    requiring the caller to pass extra arguments.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck
node --import tsx --test tests/*.test.ts
npm run build
```

### Test Coverage

- New/modified test files:
  - `tests/prompts.test.ts` (assertions adjusted for new system prompt)
  - `tests/inject-utils-pure.test.ts` (rewritten for new cadence)
  - `tests/acp-status.test.ts` (new tests for mode/sort/limit/range)
  - `tests/compress-search.test.ts` (new test for enriched error)
- Test count: target ≥ existing pass rate; exact counts recorded at PR time.
- Key scenarios verified:
  - First-turn no-nudge + baseline establishment
  - 5% growth triggers nudge regardless of contextPct floor
  - acp_status summary/detailed modes render correctly
  - acp_status sort=age/size orders correctly
  - compress failure error includes visible range + block count

### Results

- **PASS/FAIL**: _(filled at PR submission)_

## 5. Risk Assessment & Rollback

- **Risk points**:
  - System prompt rewrite could shift model behavior; mitigated by keeping
    wording factual and avoiding imperative verbs.
  - More frequent nudges at low context could increase token spend slightly on
    small-context models; mitigated by 6K-token growth floor.
- **Rollback method**:
  - Revert per-block commits independently. Each block is self-contained.
- **Compatibility notes** (data format, config schema): No schema changes.
  `minNudgeContextPercent` field preserved as no-op for old configs.

## 6. Lessons Learned (optional)

- _(filled post-review)_

## 7. Follow-ups (optional)

- [ ] Block B (nudge text rewrite) — separate iteration after experiments.
- [ ] Consider exposing `acp_status` data via `search_context` for unified lookup.
