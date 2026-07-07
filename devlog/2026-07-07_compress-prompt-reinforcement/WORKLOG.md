# WORKLOG — Compress summary-structure prompt reinforcement

## Summary

Reinforced the 4-point SUMMARY STRUCTURE in two high-leverage locations to
counteract few-shot interference from legacy summaries already in context.
The full structure text lives in the `compress` tool description (PR #63);
this change surfaces a concise version at (a) the system-prompt head and
(b) the compress-nudge action point, so the model is reminded of the required
format both globally and at the moment it is about to compress.

## ChangeLog

| Commit | File | Change |
|--------|------|--------|
| (this PR) | `lib/prompts/system.ts` | New `SUMMARY STRUCTURE` section after `TOOLS`: 4 concise points (cover / transcribe verbatim / recoverable / why omitted) + explicit anti-mimicry note. |
| (this PR) | `lib/messages/inject/inject.ts` | Append one-line `📝 New summaries must follow the SUMMARY STRUCTURE …` reminder to the breakdown string immediately after the "💡 Compress incrementally" tip (fires on every compress nudge). |

## Key Files

- `lib/prompts/system.ts` — base system prompt constant (`SYSTEM`), rendered by
  `lib/prompts/index.ts`. Non-editable; only the 6 prompts in `store.ts` are
  user-overridable. New section is additive, no existing line changed.
- `lib/messages/inject/inject.ts` — `injectCompressNudges()` builds the
  breakdown string (context usage + categories + largest ranges + tips) when
  `decision.shouldNudge === true`. Reminder appended at the action point
  (after the incremental tip, before `appendToLastTextPart`).

## Design Notes

**Why two locations, not one.** The compress-structure prompt had a single
home (tool `description`) and was being overpowered by 37 in-context legacy
summaries. Two reinforcements cover the two failure modes:

- (a) **System prompt** — global, high-attention, read every turn. Raises the
  baseline weight of the structure so it isn't drowned by few-shot examples.
  Placed right after `TOOLS` (early = higher attention) and adjacent to the
  tool it governs.
- (b) **Nudge-time reminder** — local, at the exact moment the model is told
  "compress now". Closest possible placement to the call-to-action; the model
  sees the required format right when it decides how to write the summary.

**Anti-mimicry note is load-bearing.** Without it, the model treats existing
summaries as correct examples and copies their style. The note explicitly tells
the model those were an older format — this is the key lever against few-shot
interference.

**Concise, not duplicated.** The system-prompt version restates the 4 points in
one line each; the full detail (with examples, "transcribe verbatim" emphasis,
recoverability mechanics) stays in the tool description. This avoids doubling
maintenance and keeps the system prompt scannable.

**Tokens are negligible.** (a) adds ~10 lines (~150 tokens); (b) adds 1 line
(~45 tokens). Per turn these are rounding error against typical 50K+ contexts.

## Testing

- `npm run typecheck` — exit 0 (no type changes; pure string edits).
- `npm run build` — success, `dist/index.js` 350.38 KB.
- Bundle verification:
  - `grep -c 'SUMMARY STRUCTURE' dist/index.js` = 2 (system prompt + nudge).
  - 4 points all present; anti-mimicry line present.
- `bun test tests/` — 563 pass / 1 fail. The 1 fail is the pre-existing
  `prompts.test.ts:53` `checkNotInsideTest` nested-t.test incompatibility with
  the bun test runner ("system prompt overrides handle reminder tags safely"),
  unrelated to this change (it tests the `store.ts` override mechanism, not the
  `SYSTEM` constant content, and fails on a bun runner quirk).

## Risk

**Low.** Two additive string edits; no logic, config, state, or type changes.
No existing line modified (both are pure insertions at clearly-bounded points).

- Worst case: the reminders have no measurable effect (few-shot interference is
  stubborn). No functional regression is possible — the edits are prompt text
  only.
- The anti-mimicry note is opinionated ("many were written under an older
  format") — accurate for sessions that predate PR #63, and harmless for
  fresh sessions (no legacy summaries to mimic).

## Lessons

- **Tool-description prompts are weak against in-context few-shot examples.**
  When a format change must take effect on sessions that already carry
  old-format output, surface the new format in the system prompt AND at the
  action point, not only in the tool description.
- **Placement matters as much as content.** The same reminder string is far
  more effective 1 line away from "compress now" than 40 lines earlier.

## Followups

- Re-measure conformance on the ML-research session after the user restarts
  opencode to load the new bundle (block 38 was the baseline non-conforming
  example).
- If interference persists, consider D3 (decompress-tool documentation) and D4
  (a decompress helper tool) — currently deferred.
- Consider whether the anti-mimicry note should age out once pre-PR#63 sessions
  are no longer in the wild.
