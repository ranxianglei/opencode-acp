# WORKLOG - Gate T1 growth nudges on the minNudgeContextPercent floor

- Task ID: `2026-08-28_min-gate-growth-nudges`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-08-28

> **2026-08-29 amendment**: the default floor was lowered **15% → 5%** (commit `f3a3fc8`, maintainer decision). See §7.

## 1. Summary

- **What was done**: added a growth-nudge floor to the T1 decision in `lib/messages/inject/inject.ts`. A growth nudge now requires the context to be at/above the **`minNudgeContextPercent` floor** (default 15% of the model context). `overMaxLimit` and the emergency override bypass the floor; when the model context limit is unknown the floor is unresolvable and growth nudges keep their pre-#342 growth-only behavior. T2/T3 tier-promotion nudges are untouched.
- **Why**: `computeShouldNudge()` (external `context-compress-algorithms/trigger`) only uses `overMinLimit` to pick the tips variant, so growth nudges fired well below any configured floor (issue #342: ten `trigger=growth` nudges at 67K–152K against a 150K minimum). `minNudgeContextPercent` (default 15) is the intended "don't nudge below this" knob and was previously a **no-op** (plumbed into `computeShouldNudge` but ignored by the policy).
- **Revision history (important)**:
  1. `0f35414` — first fix gated on `minContextLimit`.
  2. `f634222` (dual-agent review) — refined to only gate when `minContextLimit` resolves (`minLimitResolved`), and corrected the stale README/CONFIGURATION defaults (45%/55% → 80%/80%, matching `lib/config.ts` since v1.14.16). **Those README/CONFIGURATION fixes are preserved.**
  3. This commit — @dog flagged in issue #342 that `minContextLimit` defaults to **80%**, so gating growth nudges on it suppresses ALL growth nudges below 80% for default users (effectively disabling compression for most of a session). The floor was corrected to `minNudgeContextPercent` (15% default), low enough that default users still get compression throughout a session. The `minLimitResolved` mechanism was dropped (my approach uses `modelContextLimit` directly).
- **Behavior / compatibility changes**: YES — growth nudges below the `minNudgeContextPercent` floor are now suppressed. This activates a previously-dormant field. No change to persisted state format or internal `dcp` tags.
- **Risk level**: Low — one floor check in an existing decision path; max/emergency paths and T2/T3 are unaffected.

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `0f35414` | fix: gate T1 growth nudges on minContextLimit (issue #342) — **superseded** |
| `f634222` | dual-agent review: `minLimitResolved` guard + README/CONFIGURATION default fixes — **README/CONFIGURATION fixes preserved** |
| `ecfe7f0` | fix: use `minNudgeContextPercent` (15%) as the growth-nudge floor, not `minContextLimit` (80% default) |
| `b71e10b` | docs: align README/CONFIGURATION/utils comment/test header with the floor redesign (re-pointed stale minContextLimit-gate references) |

### Key Files

- `lib/messages/inject/inject.ts` — `nudgeAllowed` now includes `(overMaxLimit || overMinNudgeFloor)` in the growth path, where `overMinNudgeFloor` is derived from `minNudgeContextPercent`.
- `lib/messages/inject/utils.ts` — reverted the `minLimitResolved` addition (dead code in the floor approach).
- `tests/inject.test.ts` — 4 floor tests (use `minNudgeContextPercent`); 2 new tests (unresolvable model limit, T2 independence); pre-existing test #27 raised into the [floor, max) range.
- `README.md`, `CONFIGURATION.md` — default corrections from the review commit (preserved); descriptions re-pointed to the floor redesign (`minContextLimit` = turn/iteration reminders only, `minNudgeContextPercent` = growth-nudge floor).
- `lib/messages/inject/utils.ts` — `@deprecated` comment on `minNudgeContextPercent` corrected (field is active; floor computed in `inject.ts`).
- `tests/inject.test.ts` — section header re-pointed from "minContextLimit gate" to "minNudgeContextPercent floor".

## 3. Design & Implementation Notes

- **Entry point / key function**: `injectCompressNudges()` in `lib/messages/inject/inject.ts`.
- **The change** (inject.ts, `nudgeAllowed`):
  ```ts
  const minNudgeFloorTokens =
      modelContextLimit !== undefined
          ? Math.round(((config.compress?.minNudgeContextPercent ?? 15) / 100) * modelContextLimit)
          : undefined
  const overMinNudgeFloor =
      minNudgeFloorTokens === undefined ||
      currentTokens === undefined ||
      currentTokens >= minNudgeFloorTokens
  const nudgeAllowed =
      emergencyOverride ||
      (decision.shouldNudge &&
          (overMaxLimit || overMinNudgeFloor) &&   // issue #342: growth floor
          growthSinceBaseline !== undefined &&
          growthSinceBaseline >= growthFloor)
  ```
- **Why `minNudgeContextPercent`, NOT `minContextLimit`**:
  - `minContextLimit` / `maxContextLimit` both default to **80%** (`lib/config.ts:199-200`). The README documents `minContextLimit` as the "soft lower threshold for **turn/iteration reminders**" (README.md:328-331) — not a growth-nudge floor. Using it as a growth floor would disable compression below 80% for default users.
  - `minNudgeContextPercent` (default **15**, `lib/config.ts:202`) is a percent-of-model-context floor, low enough that default users still get growth nudges throughout a session, while remaining configurable (e.g. set to 37.5 for a 150K floor on a 400K model). It was already plumbed into `computeShouldNudge` (inject.ts:297) but ignored by the external policy — so it was the natural, intended field.
  - `overMaxLimit ||` keeps the strong max-limit alert working even when the floor is set above the context (defensive against misconfiguration).
- **Unresolvable floor**: when `modelContextLimit` is unknown (a model that doesn't report `limit.context`), the floor can't be computed, so `overMinNudgeFloor` stays `true` (no gate) — preserving pre-#342 growth-only behavior. This is the same intent as the review commit's `minLimitResolved` guard, implemented directly.
- **Why the fix lives in ACP, not the external package**: `context-compress-algorithms` is a shared, version-pinned dependency; the floor is ACP-specific policy (ACP owns `minNudgeContextPercent` semantics). No dependency bump.
- **Caveat**: `minNudgeContextPercent` is a global percent (no per-model `modelMinNudgeContextPercent` variant). A user who set a per-model `modelMinLimits` (like the #342 reporter) expresses the floor as a global percent instead; a per-model variant is a follow-up enhancement.
- **T2/T3 independence**: the tier-promotion nudges (inject.ts, `tierChecks` loop) use their own `nudgeGrowthTokens`/`growthFloor` cadence and never consult the floor — preserved (locked by a dedicated test).

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
- `npm run build`: success; floor logic confirmed present in `dist/index.js` (`minNudgeFloorTokens`/`overMinNudgeFloor`), old `minGateOpen`/`overMaxLimit || overMinLimit` removed.
- `npm run test`: **1035 tests, 0 failures**.

### New / adjusted tests (tests/inject.test.ts)

| Test | Asserts |
|------|---------|
| `issue #342: growth nudge suppressed below the minNudgeContextPercent floor, fires once context crosses it` | Multi-turn: `minNudgeContextPercent=30` (300K floor) — 200K < 300K → suppressed (baseline + lastNudgeShownTokens preserved); 320K ≥ 300K + growth → fires. |
| `issue #342: full growth cycle baseline → nudge → compress → new baseline → nudge (floor open)` | Full cycle with the floor open; baseline resets on compress, nudge re-fires after new-baseline growth. |
| `issue #342: growth floor holds in production config (preserveRecentMessages > 0)` | §5.7.1 production-config requirement: floor suppresses below it with `preserveRecentMessages: 2` and compressible content present. |
| `issue #342: over-max nudge bypasses the growth floor` | Defensive: floor set above the context — over-max context still nudges (overMaxLimit bypass). |
| `issue #342: growth nudge still fires when the model context limit is unknown (floor unresolvable)` | Unknown model limit → floor unresolvable → pre-#342 growth-only behavior preserved (nudge fires). (Review-commit regression lock, re-pointed at the floor.) |
| `issue #342: T2 tier-promotion fires below the growth floor (independent of the floor)` | Floor set at 800K — T1 floor-suppressed, T2 fires on its own cadence (lastTier2NudgeTokens set). (Review-commit test, re-pointed at the floor.) |

### Existing tests updated

- `stale contextLimitAnchors ... (issue #27)` — context raised from 100K (10% of 1M) to 150K so it sits in the [15% floor, max-limit) range; the previously-dormant 15% floor now suppresses below 150K, so the original 100K context no longer satisfies the floor.

### Note on `npm run format:check`

Pre-existing repo-wide Prettier drift: the installed Prettier (3.9.5) reformats 412 files (including unmodified `lib/config.ts`, `lib/hooks.ts`). CI does not enforce format. New code matches the file's existing style (4-space, no-semi, double-quote); not reformatting to avoid a noisy repo-wide diff.

## 5. Rollback Plan

- Revert the commits; no schema/config/data migrations.

## 6. Lessons Learned

- **`minContextLimit` defaults to 80%, not 45%.** The README's `45%` example was stale (the real default is `"80%"` in `lib/config.ts:200` since v1.14.16). Never assume a documented example value is the default — check `config.ts`. The review commit corrected the docs; this commit corrects the code to match the intent.
- The first revision (gate on `minContextLimit`) was a **silent regression for default users**: it would have suppressed all growth nudges below 80%. The pre-existing test #27 (context 100K on a 1M model) only caught it because 100K < 150K floor — a test with context between 150K and 800K would have masked the regression. Always check the **default** config path, not just the configured path.
- `minNudgeContextPercent` was a dormant no-op field — the natural home for the growth floor. Activating a dormant field is lower-risk than repurposing a live one (`minContextLimit` also drives turn/iteration anchors).
- A dual-agent review pushed refinements onto the branch based on the original (minContextLimit) approach; the @dog feedback superseded them. Integrated the review's valuable non-conflicting work (README/CONFIGURATION fixes, the unresolvable-limit + T2-independence tests) while replacing the core gate.

## 7. Amendment: default floor lowered 15% → 5% (maintainer decision)

- **Commit**: `f3a3fc8` — `fix: lower default minNudgeContextPercent floor 15% -> 5%`
- **Why**: the 15% default was a silent, bug-level behavior change for the dominant user profile — **large-window models (e.g. 1M context)** with small baselines. Floor mechanics: the floor binds when `P% × W > baseline + 50K` (growth threshold). At 15% that binds on windows ≥ ~400–667K; on a 1M window every compress cycle is suppressed until 150K context usage. The typical working cycle (baseline 10–50K → grow +50K → nudge → max ~110K → compress → land 20–50K → repeat) never reaches 150K, so the nudge — and therefore compression — is starved and the working range shifts to [~40K, 150–200K], ~2× steady-state input tokens. Since compress resets `lastPerMessageNudgeTokens` to the post-compress size, the floor re-binds **every** cycle, not just the first.
- **Why 5%**: with the fixed 50K growth threshold, a 5% floor only binds when `5% × W > baseline + 50K`, i.e. windows ≥ ~1.2–2M for typical baselines — inert for essentially all real working cycles while still catching pathological tiny-window thrash via `minimum: 0` users opting out. Escape hatches: set it higher explicitly (15–30%) to wait for larger usage; `0` disables the floor entirely.
- **Files**: `lib/config.ts` (default 15→5), `lib/messages/inject/inject.ts` (policy passthrough + floor fallback `?? 5`, rationale comment), `dcp.schema.json` (default + stale description fixed), `CONFIGURATION.md`/`CONFIGURATION.zh-CN.md` (defaults + rationale), `tests/inject.test.ts` (2 comments re-pinned to the buildConfig factory value; new default-lock test).
- **Test**: `issue #342 follow-up: unset minNudgeContextPercent falls back to the low 5% default floor` — deletes the field from the config (fallback path), 1M window, baseline 50K, current 100K → asserts the nudge fires (100K ≥ 50K floor + 50K growth). Mutation-sensitive: reverting the fallback to `?? 15` puts the floor at 150K → suppressed → test fails (verified locally: 54/55 with mutation, 55/55 after restore; full suite 1036/1036, typecheck + build clean).
