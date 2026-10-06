# WORKLOG - Relay usage-inflation sanitization + empty-range nudge suppression

- Task ID: `2026-10-06_usage-inflation-nudge-fix`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-10-06

## 1. Summary

- **What was done** (1–3 sentences): Sanitized the token-usage channel feeding the nudge/growth heuristics so an inflated relay report can no longer fabricate growth; closed the last zero-ranges hole in the nothing-to-compress gate; made compress boundary errors enumerate the actual free ID spans.
- **Why** (1–3 sentences): Issue #476 — a third-party gateway reported prompt usage at 1.76–2.05× reality; ACP inherited that number verbatim as `prePruneTokens`/`currentTokens`, which tripped growth nudges in sessions whose visible context was entirely compressed blocks (zero actionable ranges). The model then guessed consumed IDs, hit `endId mNNNNN is not available`, and thrashed for 15+ minutes per step.
- **Behavior / compatibility changes**: Yes — see "Behavior changes" below (values on the re-estimate path only; one new suppression case; boundary error text changed; new optional persisted field).
- **Risk level**: Low (honest usage reports pass through byte-identical; all new logic is additive and gated)

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `<sha>` | fix: sanitize inflated relay usage reports + suppress empty-range growth nudges (#476) |

### Key Files

- `lib/usage-sanity.ts` — NEW: `resolveCurrentUsage()` cross-turn inflation detector + `estimatePayloadTokens()` fast chars/4 payload estimator. Constants: `RELAY_INFLATION_RATIO = 1.5`, `PAYLOAD_FLOOR_TOKENS = 5000`.
- `lib/state/types.ts` — `SessionState.usageSanity?: { reported, estimated }` persisted baseline pair.
- `lib/state/persistence.ts` — field added to `PersistedSessionState` + saved in `saveSessionState`.
- `lib/state/state.ts` — `ensureSessionInitialized` restores the record with finite/≥0 validation; corrupted records are dropped (detection skips one turn).
- `lib/messages/inject/utils.ts` — `isContextOverLimits` now sources `currentTokens` from `resolveCurrentUsage` instead of raw `getCurrentTokenUsage`.
- `lib/hooks.ts` — `prePruneTokens` and `postTokens` sourced from `resolveCurrentUsage(..., logger)` (warn log available here).
- `lib/messages/inject/inject.ts` — new `noRangesAtAll` flag OR-ed into `nothingToCompress`; new audit reason `no_compressible_ranges`.
- `lib/compress/search.ts` — `buildBoundaryRecoveryHint` rewritten to enumerate contiguous free spans (`Free ranges: m00001–m00002, m00005–m00007.`), cap 8 spans + `(+N more)`, ending `Retry with IDs inside the free ranges.`
- `tests/usage-sanity.test.ts` — NEW, 10 tests (unit: estimator filtering, first-turn seed, honest passthrough, 1.76× re-estimate, legit-growth non-flag, sub-floor skip, compaction sentinel, record honesty, save/load round-trip, init restore/corruption).
- `tests/nudge-no-ranges-suppression.test.ts` — NEW, 3 tests (case-(a) suppression multi-turn w/ side-effect assertions; end-to-end inflation→baseline-correction; control proving nudges still fire when ranges exist).
- `tests/boundary-recovery-hint.test.ts` — NEW, 6 tests (gapped spans, contiguous single span, single bare ref, span cap, no-`acp_status` regression guard, empty-visible edge).

## 3. Design & Implementation Notes

See DESIGN.md for the full rationale. Load-bearing decisions:

1. **Jump-based detection, not absolute comparison.** chars/4 undercounts CJK up to ~4×, so comparing reported-vs-estimated directly would false-positive on honest CJK-heavy sessions. The gate fires only when the *report* jumps >1.5× while the *payload* jumps ≤1.5× (both estimates ≥5000 tokens floor). Known accepted limitation: a one-shot inflation that then holds steady passes the jump gate (documented in module docstring).
2. **Same sanitized channel at all three call sites.** `isContextOverLimits`, `prePruneTokens`, and `postTokens` all go through `resolveCurrentUsage`, so baseline arithmetic stays consistent whether or not detection fires. Double invocation per transform is harmless (second call compares against same-turn write, ratio ≈ 1).
3. **Case (a) is the only remaining hole.** Pre-fix, `nothingToCompress=false` was reachable exactly when `compressible.length === 0 && protected.length === 0 && protectedRefs.size === 0` (visible window holds only compressed-block summaries). All other zero-ranges combinations were already covered by `allProtected` / `allInProtectedZone` / `allBelowMin`.
4. **Hint enumerates free spans, not a window.** The old `Current visible: first–last (N msgs)` implied continuity across consumed gaps; the model retried with consumed IDs. Spans are derived from the ref indexes actually present in both `byRef` and `rawMessagesById`.

## 4. Verification

- Targeted tests: `node --import tsx --test tests/usage-sanity.test.ts tests/boundary-recovery-hint.test.ts tests/nudge-no-ranges-suppression.test.ts` → **19/19 pass**.
- `npm run typecheck` → clean.
- **Fail-on-bug matrix (§5.7)** — each fix temporarily reverted, corresponding test confirmed FAILING, fix restored:
  - AC3 revert (drop `|| noRangesAtAll`) → nudge test 1 fails (phantom nudge injected); instrumentation showed `nudgeAllowed:true` with zero ranges.
  - AC1/AC2 bypass (return reported usage directly) → nudge test 2 fails (baseline not corrected from 100_000 to 7_000).
  - AC4 revert (old hint text) → boundary test 1 fails.
- Global regression suite deferred to CI per local-test discipline (owner policy 2026-10-01).

## 5. Behavior changes (old → new)

| # | What | Old | New | Why |
|---|------|-----|-----|-----|
| 1 | `prePruneTokens` / `postTokens` / `currentTokens` values | Raw reported usage, inherited verbatim | Sanitized via `resolveCurrentUsage`; identical unless relay inflates (>1.5× report jump with ≤1.5× payload jump, both ≥5000 est.) | Inflated relays must not reach growth heuristics (#476 defect 1+2) |
| 2 | Growth-nudge suppression cases | `all_protected`, `in_protected_zone`, `below_effective_floor`, `no_executable_candidates` | + `no_compressible_ranges` (zero compressible AND zero protected messages) | Phantom nudges with no actionable ranges drove ID-guessing thrash (#476 defect 3) |
| 3 | Compress boundary-error recovery hint | `Current visible: first–last (N msgs). … Call acp_status() to see which blocks consumed which IDs, then retry with valid IDs.` | `Free ranges: <contiguous spans, cap 8 (+N more)>. K active compressed blocks. Retry with IDs inside the free ranges.` | First–last window implied continuity across consumed gaps (#476 defect 4) |
| 4 | Persisted state | No `usageSanity` field | Optional `usageSanity {reported, estimated}` appended | Cross-turn baseline survives restart; old files load fine (detection skips one turn until seeded) |
| 5 | New log line | — | WARN `Relay usage inflation detected — re-estimating context size` with old/new values | Operator visibility into relay misreporting |
