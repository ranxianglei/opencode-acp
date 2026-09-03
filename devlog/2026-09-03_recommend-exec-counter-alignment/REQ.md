# REQ: Align nudge recommendation-side and compress execution-side character counting (Issue #359)

**Source**: https://github.com/ranxianglei/opencode-acp/issues/359 (found during analysis of #355; same family as historical incident #37)

## Problem

Ranges listed in the nudge recommendation can still be rejected by the compress
pipeline's min-size check because the two sides count characters differently:

| Side           | Location                                                                                           | text part         | tool part                                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Recommendation | `buildCompressibleRanges` (`lib/messages/inject/utils.ts`)                                         | `text.length / 4` | `JSON.stringify(whole part).length / 4` — includes `type/tool/callID/state.status/metadata` field overhead + JSON escaping |
| Execution      | `countMessageCharacters` (`lib/token-utils.ts:224-237`), summed in `lib/compress/range.ts:180-201` | `text.length`     | `extractToolContent` = input + output/error content length (raw string used as-is)                                         |

Measured (v1.14.26, #355 author session): 4-message range dominated by two tool
parts passed the nudge-side 750-token floor but the pipeline reported
`Range too small (2760 chars, min 3000)`. The nudge is the primary guidance
surface for most agents (they never call `acp_status`), so the recommendation
itself was untrustworthy. Same family as #37 (ses_7fb5cbc8: displayed 10.8K
compressible → pipeline resolved 3066 chars → rejected → model retried ×10).

## Root cause (verified in code)

- Execution side: after soft filters (`filterProtectedToolMessages`,
  `filterLastUserMessage`, `filterProtectedRecentMessages`), `range.ts` sums
  `countMessageCharacters(rawMessage)` per surviving message and throws when the
  sum < `compress.minCompressRange`.
- Recommendation side: `buildCompressibleRanges` accumulates
  `Math.round(JSON.stringify(part).length / 4)` per non-text/non-reasoning part.
  For tool parts this overstates content by the part-wrapper JSON field names +
  metadata + escaping overhead (every newline in an error stack doubles under
  `JSON.stringify`; quotes inside stringified-JSON string outputs get escaped).
  Systematic ~10–40%+ overestimate for tool-heavy messages; pure-text messages
  agree on both sides.
- Floor: `resolveEffectiveFloor(config)` = `minCompressRange / 4` tokens, applied
  to `effectiveTokens` in `filterRecommendedRanges`. Because `effectiveTokens`
  inherits the inflated per-part counter, sub-floor tool-heavy ranges pass the
  recommendation gate and fail the execution gate.

Not a duplicate of #325: #325 fixed the _soft-filter_ dimension (raw →
effectiveTokens + config-derived floor) but kept the divergent per-part counter.

## Goal / Acceptance criteria

1. `buildCompressibleRanges` computes per-message tokens with
   `countMessageCharacters(msg) / 4` in BOTH branches (compressible + protected),
   making the recommendation gate ≡ the execution-side acceptance predicate
   (modulo per-message rounding ≤ 0.5 tokens/message — negligible against the
   default 5000-char / 1250-token floor).
2. Per-part loops retained ONLY for classification (`isTool`, `toolPct`,
   `hasMeaningfulPart`, protected tool-name collection) — no behavioral change to
   grouping, soft-filter mirroring, or zone sizing.
3. Regression tests pin the two-side delta with fixtures:
    - pure-text message
    - normal-completed tool (string output)
    - error-state tool with multi-line stack trace
    - deeply nested JSON object output
4. §5.7.3: new regression tests verified to FAIL against pre-fix code (surgical
   revert → red → restore → green).
5. `npm run typecheck`, `npm run test`, `npm run format:check` all green.

## Non-goals

- Display-only counters using the same pattern (`estimateContextComposition`
  breakdown, `acp_status` largest-ranges, notification stats) — cosmetic, do not
  affect any acceptance predicate; separate follow-up if wanted.
- Zone-sizing counters (`computeProtectedRefs` ↔ `filterProtectedRecentMessages`)
  — BOTH sides intentionally use the identical counter there, so zone boundaries
  already match; untouched.
- Adding a `CompressibleRange.chars` field (acp-kernel style) — per-message ÷4
  rounding drift is bounded (≤ 0.5 tokens/msg) and negligible; keeps the public
  range shape/API stable.
