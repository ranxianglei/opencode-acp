# WORKLOG - Nudge Text: Content-Aware v2

- Task ID: `2026-06-28_nudge-text-content-aware-v2`
- Home Repo: `opencode-acp`
- Status: InProgress
- Updated: 2026-06-28 19:00

## 1. Summary

- **What was done**: Changed compression nudge text from threshold-driven
  ("ample = do not compress") to principle-driven ("Be frugal, compress proactively, extract and
  keep what matters"). Removed visible threshold numbers, made block ID listings summarize when
  >20 blocks are active, and added the `decompress` safety net to every nudge surface.
- **Why**: Earlier aggressive nudges caused reckless deletion; the conservative "ample" reaction
  overcorrected and wasted tokens by suppressing compression entirely at low pressure. Because
  `decompress` now makes compression reversible, a more proactive stance is safe and lets the
  model act instead of deliberate.
- **Behavior / compatibility changes**: No — text-only changes. No logic, config schema, anchor
  mechanics, or injection timing changes. Model-visible wording changed.
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| _(pending — 5 files staged, not yet committed)_ | Nudge text: principle-driven, content-aware v2 |

### Key Files (5 files, +21/-14 lines)

- `lib/messages/inject/utils.ts` — Per-message context indicator: removed threshold numbers from
  guidance, changed "ample" framing to the "Be frugal" principle; low-tier guidance now tells the
  model to compress finished tool outputs and extract what matters, with decompress as safety net.
- `lib/prompts/system.ts` — System prompt pressure levels: "Ample: Do NOT compress" →
  "Normal: Be frugal"; Elevated/Critical reframed as progressively more urgent compression rather
  than permission gates.
- `lib/prompts/extensions/nudge.ts` — Compressed-block guidance: when there are more than 20
  active blocks, list only the 20 most recent IDs plus `(+N older, use decompress to access by ID)`
  instead of dumping every ID; per-message guidance now nudges compression of consumed tool
  outputs.
- `lib/prompts/turn-nudge.ts` — Turn nudge: "compress now" → "if you've finished reading tool
  outputs or exploration results, compress them" + decompress-later safety net.
- `lib/prompts/context-limit-nudge.ts` — Limit nudge: "CRITICAL MUST NOW" tone → "time to
  compress the largest ranges you no longer need" + decompress-later safety net.

## 3. Design & Implementation Notes

- **Entry point / key function**:
  - `buildContextUsageGuidance(config, currentTokens, modelContextLimit)` in
    `lib/messages/inject/utils.ts` — resolves config thresholds to percentages, selects one of
    three guidance tiers, and emits principle-based text.
  - `buildCompressedBlockGuidance(state, gcConfig?, context?)` in
    `lib/prompts/extensions/nudge.ts` — formats the active block ID list with the >20 summary
    fallback.
- **Key configuration items**: `compress.minContextLimit` and `compress.maxContextLimit`
  (unchanged defaults `45%` / `55%`) still drive tier selection; the values themselves are no
  longer echoed to the model.
- **Key logic explanation**: Thresholds are still used internally to pick a tier, but the model
  only sees outcome-based language ("Be frugal", "Context is growing", "Context is high"). This
  removes the model's ability to game explicit numbers and keeps guidance stable as config tuning
  happens behind the scenes.

## 4. Testing & Verification

### Build & Test Commands

```sh
# Build
cd opencode-acp && npm run build

# Run full test suite
node --import tsx --test tests/*.test.ts

# Run the new test file in isolation
node --import tsx --test tests/nudge-text.test.ts

# Type check
npx tsc --noEmit
```

### Test Coverage

- New/modified test files: `tests/nudge-text.test.ts`
- Test count: 486 total (full suite), 486 pass, 0 fail (7 new in `nudge-text.test.ts`)
- Key scenarios verified:
  - TURN_NUDGE uses conditional ("finished reading") language + decompress safety, no standalone
    "now" command.
  - CONTEXT_LIMIT_NUDGE uses "time to compress" + decompress safety, no "MUST"/"CRITICAL".
  - `buildCompressedBlockGuidance` lists all IDs at ≤20 blocks; summarizes with `+N older` at >20.
  - `buildContextUsageGuidance` emits "Be frugal" at low pressure (no "threshold" leak),
    "Context is growing" at moderate, "Context is high" at high.

### Results

- **PASS/FAIL**: PASS — typecheck clean; full suite 486/486; new file 7/7.
- **Key logs/data**: `format:check` reports 90 pre-existing files (all devlog markdown +
  many pre-existing test files). No `.prettierignore` exists; devlog markdown is
  unformatted-by-convention (every prior devlog entry is similarly flagged). The new
  `tests/nudge-text.test.ts` is prettier-clean.

## 5. Risk Assessment & Rollback

- **Risk points**: Model may now compress slightly more eagerly than before; mitigated by
  `decompress` reversibility and the system prompt's "compress selectively / DO NOT RE-COMPRESS"
  guardrails.
- **Rollback method**:
  - Revert commit(s): _(pending sha)_
  - Rollback impact: Restores "ample" low-tier guidance; no data/config migration to undo.
- **Compatibility notes**: No schema or data-format changes. Purely model-visible text.

## 6. Lessons Learned (optional)

- Threshold numbers in model-visible text become permission gates the model reasons about;
  keeping them internal lets the principle ("be frugal") stay stable across config tuning.
- Reversible compression (`decompress`) is what unlocks a proactive nudge posture without the
  old risk of information loss.

## 7. Follow-ups (optional)

- [ ] Observe real-session token spend after merge to confirm the 3–5× reduction expectation.
- [ ] Consider whether the block-aging GC warning text also needs a decompress safety mention
  (currently it points to re-compression only).
