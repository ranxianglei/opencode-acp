# REQ — Sanitize inflated relay usage reports + suppress empty-range growth nudges

Issue: https://github.com/ranxianglei/opencode-acp/issues/476
Branch: `2026-10-06_usage-inflation-nudge-fix`

## Problem

`prePruneTokens` / all nudge-threshold inputs derive from
`getCurrentTokenUsage()`, which returns the **previous request's upstream-reported
usage** (`input + cacheRead + cacheWrite + output + reasoning`). A third-party
relay can inflate that number (measured 1.76–2.05× in #476); the inflated value
flows unbound into the growth heuristic and triggers compression nudges even
though the actual outgoing payload is small. Two independent defects compound:

1. **Stale/inflated usage channel** (`lib/token-utils.ts:9`, consumed by
   `isContextOverLimits` at `lib/messages/inject/utils.ts:197` and by
   `prePruneTokens`/`postTokens` in `lib/hooks.ts`). No sanity check compares
   the reported figure against the actual outgoing message list.
2. **Zero-ranges hole in nudge suppression** (`lib/messages/inject/inject.ts:484`):
   `nothingToCompress = allProtected || allInProtectedZone || allBelowMin`. When
   the analysis finds neither compressible ranges nor protected messages
   (visible context = compressed blocks + recent zone only), none of the three
   flags is true → a growth nudge fires with no actionable ranges → the model
   guesses IDs → `endId ... not available` errors → retry loop (the 15-minute
   thrash in #476).
3. **Unhelpful compress error hint** (`lib/compress/search.ts:259`): on an
   unresolvable boundary the recovery hint says "call acp_status()" without
   listing which ranges are actually still free.

## Acceptance criteria (from issue)

1. Recount `prePruneTokens` from the message list actually being sent instead
   of deriving it from the previous request's reported usage.
2. Reject or re-estimate when reported usage jumps >1.5× without a
   corresponding payload change (relay inflation must not reach the growth
   heuristic).
3. Suppress growth nudges when there are no compressible targets, matching the
   existing suppression paths.
4. On compress validation failure return the still-compressible ranges in the
   error instead of "call acp_status(), retry".

## Out of scope

- Fixing the relay itself (external service).
- Switching steady-state token accounting to an estimate-only scheme (would
  shift every calibrated threshold for honest providers; see DESIGN.md).
- Changes to the trigger policy package (`context-compress-algorithms`).

## Related

- #346 (closed, PR #349): limit-unknown in spawn+resume mode — shares the
  `post==pre` symptom, different root cause. Not a duplicate.
- #436: nudge round-trip cost — adjacent but separate mechanism.
