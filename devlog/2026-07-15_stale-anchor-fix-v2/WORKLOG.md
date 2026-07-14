# WORKLOG: Stale contextLimitAnchors Fix (v2)

## Branch
`2026-07-15_stale-anchor-fix-v2` (from `github/master` at `e73bfc6`, post v1.12.5 release)

## Changes

### `lib/messages/inject/inject.ts`
- Changed `else if (overMinLimit)` → `else { ... if (overMinLimit) { ... } }`
- Added stale `contextLimitAnchors.clear()` + `anchorsChanged = true` in the new `else` branch
- Re-indented the `overMinLimit` block one level deeper (no logic change)

### `tests/inject.test.ts`
- Test 1: "stale contextLimitAnchors cleared when context drops below maxLimit without compress"
- Test 2: "stale contextLimitAnchors: contextLimitNudge NOT injected when context below limit"

## Verification
- TypeScript: pass
- Tests: 690 pass (688 existing + 2 new), 0 fail
- Build: pass
