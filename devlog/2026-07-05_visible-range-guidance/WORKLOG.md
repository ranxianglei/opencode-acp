# WORKLOG - Visible Range Guidance & Compression Failure Recovery

- Task ID: `2026-07-05_visible-range-guidance`
- Home Repo: `opencode-acp`
- Status: InProgress
- Updated: 2026-07-06 10:15

## 1. Summary

- **What was done** (1–3 sentences): Rewrote the system prompt to list all four
  context tools with when-to-use hints, explicit compress / do-not-compress
  scenes, batch-compression guidance, and a CONTEXT BREAKDOWN section; switched
  nudge cadence from "15% floor + 5% growth" to pure 5% growth with first-turn
  baseline; upgraded `acp_status` with `mode`/`sort`/`limit` args and per-block
  size + ID-range display; enriched `compress` boundary failures with the
  current visible range and an `acp_status` pointer; added a 3-category
  (tool/code/text) context-composition breakdown to the suffix nudge with the
  largest ranges in each category; hardened `search.ts` to clamp
  out-of-range endId guesses; raised `maxSummaryLengthHard` 4000 → 8000 → 10000;
  removed the stale `MODEL_CONTEXT_LIMITS` fallback table; fixed a
  fire-and-forget `saveSessionState` race.
- **Why** (1–3 sentences): The model repeatedly tried to compress IDs already
  consumed by prior blocks because it had no visibility into what remained
  compressible. Failure errors gave no recovery info, wasting turns; the nudge
  gave no actionable breakdown of where tokens were actually spent; and the
  `MODEL_CONTEXT_LIMITS` fallback silently mis-reported context limits when the
  host SDK omitted `model.limit.context`, distorting the percentage math.
- **Behavior / compatibility changes**: Yes — nudge frequency changes (more
  frequent at low context usage on large models); `acp_status` output format
  expands; system prompt text fully replaced; suffix nudge gains a 3-category
  breakdown + largest-ranges list; `search.ts` now clamps out-of-range endId
  guesses to the last visible message instead of failing; `minNudgeContextPercent`
  config field preserved as no-op; `modelContextLimit` is now sourced solely
  from `input.model.limit.context` (host SDK) — providers that omit it will see
  `undefined` limits rather than a stale guess.
- **Risk level**: Medium (prompt-behavior changes; mitigated by per-block
  commits and the deferred-then-completed nudge-text rewrite).

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `4cdbbb3` | feat(prompt): rewrite system prompt — list all 4 tools, add compress/don't-compress scenes, drop 'promptly' |
| `8ae0f2d` | feat(nudge): drop 15% context floor, switch to growth-only cadence with first-turn baseline |
| `8e338e3` | feat(acp_status): add mode/sort/limit args + show compressed size and mNNNNN ranges per block |
| `7e183f9` | feat(compress): enrich boundary failure error with visible range and acp_status pointer |
| `abeb74b` | docs(devlog): add REQ/DESIGN/WORKLOG for visible-range-guidance iteration |
| `7dc1bce` | docs(devlog): fill in commit SHAs and PR link in WORKLOG |
| `a2ce83a` | fix(prompt): address PR #55 review — restore BE FRUGAL, nuance compress/don't-compress, add toFile, drop '~5%' |
| `46970c9` | fix(persistence): make STORAGE_DIR dynamic to respect runtime XDG_DATA_HOME changes |
| `17954a0` | fix(inject): remove anchorsChanged from baseline to prevent fire-and-forget save race |
| `b754236` | fix: add .catch() to all fire-and-forget saveSessionState calls |
| `b3306ef` | fix(nudge): auto-reset stale baseline when token count drops significantly |
| `70ef7c8` | feat(prompt): add batch compression guidance — aim for 20+ messages per compress call |
| `38f545c` | feat(nudge): add context composition breakdown + tool output accumulation reminder |
| `d8067a1` | fix(nudge): correct summary detection + add largest message ranges + drop 'promptly' from guidance |
| `bff028a` | chore: increase maxSummaryLengthHard default 4000 → 8000 |
| `92e83cb` | fix(nudge): top 10 messages, add ranges+tool suggestion to Part B, add ignore note |
| `12765e7` | fix(nudge): add largest ranges to all tips variants + breakdown to Part B standalone |
| `d243c28` | fix: infer modelContextLimit from model ID + tighten ignore exemption |
| `7e1c1ce` | fix(nudge): remove all 'ignore' exemptions, add 'context is precious' to all tips |
| `48597c4` | fix(nudge): normal variant now lists top 5 largest tool outputs explicitly |
| `77ef11a` | fix: compression summaries injected as assistant role with system-metadata tags |
| `1b935af` | feat(nudge): 3-category breakdown (tool/code/messages), remove per-turn tips |
| `cc1c7c2` | fix(review): M1-M4 from dual-agent review #2 |
| `3f2b44f` | feat(prompt): add CONTEXT BREAKDOWN section explaining new nudge format |
| `167c2c4` | fix: search fault tolerance, summaryMaxChars 10K, code token dedup, soften wording |
| `095fa29` | refactor: remove stale MODEL_CONTEXT_LIMITS table, rely on op model.limit.context |
| `61b6ba8` | feat(prompt): add task-phase-end compression trigger |

**PR**: https://github.com/ranxianglei/opencode-acp/pull/55

### Key Files

- `lib/prompts/system.ts` — full rewrite of system prompt body (tools list,
  compress/don't-compress scenes, batch guidance, CONTEXT BREAKDOWN, task-phase-end trigger).
- `lib/messages/inject/utils.ts` — `computeShouldNudge` logic (15% floor dropped);
  context-composition computation (`ContextComposition` with `textTokens` field);
  baseline auto-reset on significant token drop.
- `lib/messages/inject/inject.ts` — first-turn baseline establishment;
  3-category breakdown (tool/code/text) injected into the suffix; largest-ranges
  per category; `anchorsChanged` removed from baseline path to prevent the
  fire-and-forget save race.
- `lib/compress/status.ts` — `acp_status` multi-mode/sort/limit + ranges.
- `lib/compress/search.ts` — enriched failure error; `clampMessageRef()` for
  out-of-range endId guesses (clamps to last visible message; registered-but-consumed
  IDs still fail with the recovery hint).
- `lib/compress/message.ts`, `lib/compress/range.ts` — `buildSchema(maxSummaryLengthHard)`
  now param-driven via `ctx.config.compress.maxSummaryLengthHard`; softened
  "compress ≠ delete" wording in the message-mode prompt.
- `lib/config.ts` — `maxSummaryLengthHard` default 4000 → 8000 → 10000.
- `lib/hooks.ts` — removed `MODEL_CONTEXT_LIMITS` import + fallback block;
  `modelContextLimit` now sourced solely from `input.model.limit.context`.
- `lib/state/persistence.ts` — `STORAGE_DIR` made dynamic (re-evaluates
  `XDG_DATA_HOME` at call time) so test harnesses and relocated data dirs work.
- `lib/model-limits.ts` — **deleted** (38-entry hardcoded fallback table +
  `inferModelContextLimit`); sole source is now the host SDK's
  `input.model.limit.context`.
- `lib/messages/inject/inject.ts`, `lib/state/state.ts` — `.catch()` added to
  every fire-and-forget `saveSessionState` call to surface async rejections.
- `tests/prompts.test.ts` — adjusted for new system prompt content.
- `tests/inject-utils-pure.test.ts` — rewritten for new nudge cadence.
- `tests/acp-status.test.ts` — extended for new modes/fields.
- `tests/compress-search.test.ts` — extended for enriched error + clamp behavior.
- `tests/e2e-blocks-nudges.test.ts` — extended for breakdown + new failure modes.
- `tests/prune.test.ts` — adjusted for assistant-role compression-summary injection.
- `tests/model-limits.test.ts` — **deleted** with `lib/model-limits.ts`.

## 3. Design & Implementation Notes

- **Entry point / key function**:
  - `computeShouldNudge` returns `shouldNudge: false` when
    `lastNudgeTokens === undefined` (first observed turn). Caller in
    `inject.ts` then sets `lastPerMessageNudgeTokens = currentTokens` to
    establish the baseline; subsequent turns use pure 5% growth logic.
  - The same baseline auto-resets when `currentTokens` drops significantly below
    the stored baseline (e.g. after a large compression) so the next nudge fires
    on the *post-compression* level rather than waiting another 5% growth cycle.
- **Key configuration items**:
  - `minNudgeContextPercent` config field is preserved for backward
    compatibility but is now ignored by `computeShouldNudge`.
  - `maxSummaryLengthHard` default raised 4000 → 8000 → 10000 across this
    iteration. The display value in the compress tool schema is now sourced from
    `ctx.config.compress.maxSummaryLengthHard` so config changes propagate.
- **Key logic explanation** (if non-trivial):
  - `acp_status` `summary` mode shows each block's `compressedTokens→summaryTokens`
    and the `mNNNNN` range it consumed (derived from `directMessageIds`
    mapped through `state.messageIds.byRawId`). `detailed` mode adds
    `survivedCount`, `generation`, effective message count, and consumed block
    lineage.
  - `resolveBoundaryIds` failure path computes the visible range inline from
    the `SearchContext`'s raw messages and the state's `byRawId` map, without
    requiring the caller to pass extra arguments.
  - `clampMessageRef()`: when the model supplies an `endId` ref that is not
    registered in `state.messageIds.byRef` *and* parses to a number higher than
    the last visible message's ref, the ref is clamped to the last visible
    message. Refs that *are* registered but were consumed by a prior block still
    fail — clamping them would silently recompress already-summarized content.
    The guard is `if (state.messageIds.byRef.has(requested.ref)) return null`.
  - Context-composition breakdown: `ContextComposition` gained a `textTokens`
    field (= `messageTokens - codeTokens`) to avoid double-counting code-bearing
    messages in both the `code` and `text` categories. The suffix nudge shows
    3 categories (`tool | summaries | code | text`) plus the largest ranges in
    the `tool` and `code` categories so the model has concrete compression
    targets rather than a bare percentage.
  - `modelContextLimit` is sourced solely from `input.model.limit.context`
    (the host SDK's declared context window). The previous `MODEL_CONTEXT_LIMITS`
    fallback table was a 38-entry hardcoded guess that drifted from reality and
    silently distorted the percentage math when the host omitted the field;
    removing it surfaces `undefined` immediately rather than masking it.

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
  - `tests/inject-utils-pure.test.ts` (rewritten for new cadence + breakdown)
  - `tests/acp-status.test.ts` (new tests for mode/sort/limit/range)
  - `tests/compress-search.test.ts` (enriched error + clamp behavior)
  - `tests/e2e-blocks-nudges.test.ts` (breakdown + new failure modes)
  - `tests/prune.test.ts` (assistant-role compression-summary injection)
  - `tests/model-limits.test.ts` (deleted with `lib/model-limits.ts`)
- Test count: **545 passing / 546**, 1 pre-existing failure unrelated to this
  branch (`tests/prompts.test.ts` nested `t.test` unsupported by the bun test
  runner shim that proxies as `node`).
- Key scenarios verified:
  - First-turn no-nudge + baseline establishment
  - 5% growth triggers nudge regardless of contextPct floor
  - Baseline auto-reset after a significant post-compression token drop
  - Context-composition breakdown: tool/code/text do not double-count
  - Largest ranges appear in the correct category of the breakdown
  - acp_status summary/detailed modes render correctly
  - acp_status sort=age/size orders correctly, limit bounds output
  - compress failure error includes visible range + block count
  - search clamps unregistered out-of-range endId to last visible message
  - search still fails (with recovery hint) on registered-but-consumed IDs

### Results

- **PASS/FAIL**: PASS — typecheck clean; `bun test tests/` → 545/546 (1
  pre-existing unrelated failure). Build + deploy verified locally.

## 5. Risk Assessment & Rollback

- **Risk points**:
  - System prompt rewrite could shift model behavior; mitigated by keeping
    wording factual and avoiding imperative verbs.
  - More frequent nudges at low context could increase token spend slightly on
    small-context models; mitigated by 6K-token growth floor.
  - Removing `MODEL_CONTEXT_LIMITS` means providers that omit
    `model.limit.context` will report `undefined` limits. This surfaces a
    previously-silent mis-config rather than masking it; acceptable because the
    host SDK declares the field for all mainstream providers.
- **Rollback method**:
  - Revert per-block commits independently. Each block is self-contained.
  - `MODEL_CONTEXT_LIMITS` removal (commit `095fa29`) reverts cleanly; the
    fallback block in `hooks.ts` was deleted verbatim.
- **Compatibility notes** (data format, config schema): No persisted-state
  schema changes. `minNudgeContextPercent` field preserved as no-op for old
  configs. `maxSummaryLengthHard` default raised to 10000 — old persisted configs
  with an explicit lower value are unaffected (explicit config wins).

## 6. Lessons Learned (optional)

- The "Block B nudge-text rewrite" originally deferred to a later iteration got
  pulled into this branch once real sessions showed the suffix gave the model
  no actionable breakdown of *where* tokens were spent. The 3-category
  (tool/code/text) breakdown with concrete largest-range candidates proved more
  useful than any percentage threshold. Lesson: defer prompt rework only when
  the current prompt is *actionable*; a prompt that says "you're at 47%" with no
  target list is not actionable.
- `MODEL_CONTEXT_LIMITS` was a 38-entry hardcoded fallback that nobody trusted
  enough to maintain. It drifted from reality and silently distorted the
  percentage math. Single-source-of-truth (`input.model.limit.context`) is
  strictly better than a stale guess, even when the host occasionally omits it.
- A fire-and-forget `saveSessionState` without `.catch()` silently drops async
  rejections; adding `.catch()` surfaced a real race where the baseline path set
  `anchorsChanged` and triggered a concurrent save. Both fixes are load-bearing.

## 7. Follow-ups (optional)

- [x] ~~Block B (nudge text rewrite)~~ — completed in this iteration (commits
  `38f545c` → `1b935af`).
- [ ] Consider exposing `acp_status` data via `search_context` for unified lookup.
- [ ] Watch for providers that omit `model.limit.context`; if more than a
  handful appear, consider a small *explicit* fallback (user-configured
  `modelContextLimit` in `acp.jsonc`) rather than reviving the hardcoded table.
