# WORKLOG - Gate T1 growth nudges on minContextLimit

- Task ID: `2026-08-28_min-gate-growth-nudges`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-08-28

## 1. Summary

- **What was done**: added a `minContextLimit` gate to the T1 growth-nudge decision in `lib/messages/inject/inject.ts`. A growth nudge now requires the context to be at/above `minContextLimit` (or to be over the max limit / in the emergency override). `overMaxLimit` and the emergency path bypass the gate; T2/T3 tier-promotion nudges are untouched. After dual-agent review, the gate was refined: it only applies when `minContextLimit` resolves to a concrete value (`minLimitResolved` from `isContextOverLimits`), so models that don't report `limit.context` (percent limits unresolvable) keep pre-#342 growth-only behavior instead of losing all growth nudges.
- **Why**: `computeShouldNudge()` (external `context-compress-algorithms/trigger`) only uses `overMinLimit` to pick the tips variant, so growth nudges were firing well below a configured `minContextLimit` (issue #342: ten `trigger=growth` nudges at 67K–152K against a 150K minimum). The README documents `minContextLimit` as the threshold below which reminder nudges are off, so the runtime contradicted the docs.
- **Behavior / compatibility changes**: YES — growth nudges below `minContextLimit` are now suppressed (the intended, documented behavior). Default config always sets `minContextLimit` (80%, raised from 45% in v1.14.16 / PR #295), so default users keep a defined gate. Consequence for default users: with `minContextLimit = maxContextLimit = 80%`, growth nudges now only fire at ≥80% of the model context window (previously as soon as growth crossed `nudgeGrowthTokens`). No change to persisted state format or internal `dcp` tags.
- **Risk level**: Low — one boolean OR in an existing decision path; max/emergency paths and T2/T3 are unaffected. The naive gate (without the `minLimitResolved` guard) was a real regression for models that don't report `limit.context` — verified live (pre-fix nudge fired, naive gate suppressed it) and locked by a dedicated test.

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `0f35414` | fix: gate T1 growth nudges on minContextLimit (issue #342) |
| `f634222` | fix: min-gate refinements from dual-agent review (resolvability guard, unmasked tests, review-finding tests, doc defaults) |

### Key Files

- `lib/messages/inject/inject.ts` — `nudgeAllowed` growth path now requires `minGateOpen = !minLimitResolved || overMinLimit || overMaxLimit`.
- `lib/messages/inject/utils.ts` — `isContextOverLimits` returns `minLimitResolved` (whether `minContextLimit` resolved to a concrete value).
- `tests/inject.test.ts` — 7 new min-gate tests; 4 existing tests had `minContextLimit` lowered so they still isolate the growth mechanism (they previously set it above the test context, which the fix now correctly suppresses).
- `README.md`, `CONFIGURATION.md` — corrected stale `minContextLimit`/`maxContextLimit` defaults (45%/55% → 80%/80%, matching `lib/config.ts` since v1.14.16) and documented the min-gate semantics for growth nudges.

## 3. Design & Implementation Notes

- **Entry point / key function**: `injectCompressNudges()` in `lib/messages/inject/inject.ts`.
- **The change** (inject.ts, `nudgeAllowed`):
  ```ts
  const minGateOpen = !minLimitResolved || overMinLimit || overMaxLimit
  const nudgeAllowed =
      emergencyOverride ||
      (decision.shouldNudge &&
          minGateOpen &&   // issue #342: min-gate
          growthSinceBaseline !== undefined &&
          growthSinceBaseline >= growthFloor)
  ```
- **Why `minGateOpen` (not just `overMinLimit`)**: in normal configs `min < max`, so `overMaxLimit` implies `overMinLimit` and the max path is unaffected. Keeping `overMaxLimit ||` makes the gate robust to a misconfigured `min > max` (an over-max context still nudges) and to a config that sets only `maxContextLimit`.
- **Why `!minLimitResolved ||` (review fix)**: `minContextLimit` only resolves to a concrete value when it is an absolute number or a `"X%"` with a known model context window. Models that don't report `limit.context` (lib/hooks.ts sets `state.modelContextLimit` from `model.limit.context` and leaves it `undefined` on catalog miss) make percent limits unresolvable — with the naive gate, `overMinLimit`/`overMaxLimit` are both `false` and **every** growth nudge for such models is suppressed (verified live pre/post fix). The guard treats "unresolvable" as "no gate", preserving pre-#342 growth-only behavior. `isContextOverLimits` (lib/messages/inject/utils.ts) now returns `minLimitResolved` so callers cannot confuse "below min" with "min unknown".
- **Why the fix lives in ACP, not the external package**: `context-compress-algorithms` is a shared, version-pinned dependency; the min-gate is ACP-specific policy (ACP owns `minContextLimit` semantics). No dependency bump.
- **T2/T3 independence**: the tier-promotion nudges (inject.ts, `tierChecks` loop) use their own `nudgeGrowthTokens`/`growthFloor` cadence and never consult `overMinLimit` — preserved.

## 4. Testing & Verification

### Build & Test Commands

```sh
cd opencode-acp && npm install
npm run build
npm run typecheck
node --import tsx --test tests/*.test.ts
```

### Results

- `npm run typecheck`: clean.
- `npm run build`: success; fix confirmed present in `dist/index.js`.
- `npm run test`: **1036 tests, 0 failures** (was 1029; +7 new).

### New tests (tests/inject.test.ts)

| Test | Asserts |
|------|---------|
| `issue #342: growth nudge suppressed below minContextLimit, fires once context crosses min` | Multi-turn: 200K < 300K min → suppressed (baseline + lastNudgeShownTokens preserved); 320K ≥ 300K min + growth → fires. |
| `issue #342: full growth cycle baseline → nudge → compress → new baseline → nudge (min-gate open)` | Full cycle with min-gate open; baseline resets on compress, nudge re-fires after new-baseline growth. |
| `issue #342: min-gate holds in production config (preserveRecentMessages > 0)` | §5.7.1 production-config requirement: min-gate suppresses below min with `preserveRecentMessages: 2` and compressible content present. |
| `issue #342: over-max nudge bypasses the min gate` | Defensive: `min > max` misconfig — over-max context still nudges (overMaxLimit bypass); also asserts the T1 baseline is untouched. |
| `issue #342: growth nudge still fires when minContextLimit is unresolvable (percent limit, unknown model limit)` | Review regression lock: `modelContextLimit` undefined + `"80%"` percent limits → gate must NOT suppress (pre-#342 growth-only behavior preserved). |
| `issue #342: emergency override bypasses the min gate` | Context ≥98% of model limit but below `minContextLimit` → emergency override still fires, baseline untouched. |
| `issue #342: T2 tier-promotion fires below minContextLimit (independent of the min gate)` | T2 fires below the min context limit (independent cadence); `lastTier2NudgeTokens` set proves T1 stayed min-gate suppressed (T2 only runs when T1 didn't fire). |

### Existing tests updated

- `injectCompressNudges: post-compress baseline then large growth DOES nudge` — `minContextLimit` 550K → 200K (was above the 305K turn-2 context; the fix now suppresses it).
- `nudge threshold halves after first nudge without compress (issue #23)` — `minContextLimit` 200K → 100K (was above the 150K/165K/175K turn contexts).
- `injectCompressNudges: post-compress baseline then small growth does NOT re-nudge` — `minContextLimit` 550K → 200K (was above the 253K turn-2 context; the fix now suppresses it, so the "no re-nudge" assertion was being satisfied for the wrong reason).
- `injectCompressNudges: baseline initialized to currentTokens on first transform` — `minContextLimit` 200K → 50K (was above the 55K/58K turn contexts).

All four still exercise their original intent (growth mechanism / threshold halving / baseline init) with the min-gate open.

### Note on `npm run format:check`

Pre-existing repo-wide Prettier drift: the installed Prettier (3.9.5) reformats 412 files (including unmodified `lib/config.ts`, `lib/hooks.ts`). CI does not enforce format. New code matches the file's existing style (4-space, no-semi, double-quote); not reformatting to avoid a noisy repo-wide diff.

## 5. Rollback Plan

- Single revert commit; no schema/config/data migrations.

## 6. Lessons Learned

- `minContextLimit` was already gating turn/iteration anchors (inject.ts:175,205) but NOT the growth nudge — the growth path was the only reminder channel that ignored the minimum.
- Several existing growth-mechanism tests set `minContextLimit` *above* the test context to keep it out of the way; once the min-gate became real, those had to be lowered to stay valid.
