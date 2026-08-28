# REQ - Gate T1 growth nudges on minContextLimit

- Task ID: `2026-08-28_min-gate-growth-nudges`
- Home Repo: `opencode-acp`
- Created: 2026-08-28
- Status: Done
- Priority: P1
- Owner: ework-daemon (qwen3.8-27b)
- References: issue ranxianglei/opencode-acp#342

## 1. Background & Problem Statement

- **Context**: ACP's T1 (message/range) compression nudges are meant to be gated by two user-configured limits: `minContextLimit` (soft lower bound — "below this, reminders are off") and `maxContextLimit` (upper bound — strong alert). The README documents `minContextLimit` as the threshold below which reminder nudges are off.
- **Current behavior (symptom)**: T1 *growth* nudges fire well below a configured `minContextLimit`. In the reporter's setup (400K window, `modelMinLimits=150000`, `modelMaxLimits=215000`, `nudgeGrowthTokens=50000`), ten `trigger=growth` nudges fired at 67K–152K tokens — all below the 150K minimum. Raising `modelMinLimits` does nothing; raising `nudgeGrowthTokens` is not a clean workaround because the same knob drives T2/T3 promotion.
- **Expected behavior**:
  - T1 efficiency (growth) nudge = `currentTokens >= minContextLimit` AND `growth >= nudgeGrowthTokens` (AND `growth >= growthFloor`).
  - T1 maximum nudge = `currentTokens >= maxContextLimit` (unchanged).
  - Emergency (≥ `emergencyThresholdPercent`, default 98%) override unchanged.
  - T2/T3 tier-promotion nudges remain independent of the min limit (useful even when working context is small).
- **Impact**: users who tune `minContextLimit`/`modelMinLimits` to defer compression get no such deferral for growth nudges; the model compresses early (80–150K) instead of at the configured floor (150K), wasting compression cycles and diverging from documented behavior.

## 2. Reproduction (if applicable)

- **Environment**: opencode-acp 1.14.25, Node 22/24, 400K-context model with `modelMinLimits=150000`.
- **Minimal reproduction steps**:
  1. Configure `compress.minContextLimit` (or `modelMinLimits`) above the session's starting context.
  2. Let context grow by ≥ `nudgeGrowthTokens` while still below `minContextLimit`.
  3. A `trigger=growth` nudge is injected despite `currentTokens < minContextLimit`.
- **Relevant configuration**: `compress.minContextLimit` / `compress.modelMinLimits`, `compress.nudgeGrowthTokens`.

## 3. Root cause

- `computeShouldNudge` (external `context-compress-algorithms/trigger`) computes `shouldNudge = growthSinceLastNudge >= nudgeGrowthTokens || overMaxLimit`. `overMinLimit` only selects the `tipsVariant` (`"minLimit"` vs `"normal"`) and does **not** gate `shouldNudge`.
- In `lib/messages/inject/inject.ts`, `nudgeAllowed = emergencyOverride || (decision.shouldNudge && growthSinceBaseline >= growthFloor)`. `overMinLimit` is passed into `computeShouldNudge` but is **not** required in `nudgeAllowed`. Turn/iteration anchors already gate on `overMinLimit` (inject.ts:175,205); only the growth path bypasses it.

## 4. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: default config always sets `minContextLimit` (80%, raised from 45% in v1.14.16 / PR #295), so default users keep a defined gate. Note the consequence: with the default `minContextLimit = maxContextLimit = 80%`, growth nudges now only fire at ≥80% of the model context window (previously they fired as soon as growth crossed `nudgeGrowthTokens`). This is the documented behavior, but it is a visible change for default users.
  - Unresolvable limits: if `minContextLimit` cannot resolve to a concrete value (a `"X%"` limit with an unknown model context window — models that don't report `limit.context`), the min gate must be skipped and growth nudges keep their pre-#342 growth-only behavior. Treating "unresolvable" as "below min" would silently disable growth nudges for all such models (regression found in review).
  - `overMaxLimit` and emergency paths must be unaffected (they imply/override the min gate).
  - T2/T3 tier-promotion nudges must remain independent of `minContextLimit`.
  - No new dependencies; no change to the external `context-compress-algorithms` package (fix lives in ACP's `inject.ts`).
  - No change to persisted state format or internal `dcp` tags.
- **Non-Goals** (out of scope):
  - Percentage-based `nudgeGrowthTokens` (issue #300).
  - The broader T1/T2/T3 decision-chain refactor (issue #300).
  - Adding a separate "T1 growth floor" config knob (the user offered it as an alternative; the min-gate is the narrower, documented fix).

## 5. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] A T1 growth nudge does NOT fire when `currentTokens < minContextLimit` (even if `growth >= nudgeGrowthTokens` and `>= growthFloor`).
  - [x] A T1 growth nudge DOES fire when `currentTokens >= minContextLimit` and `growth >= nudgeGrowthTokens` and `>= growthFloor`.
  - [x] A T1 maximum nudge still fires when `currentTokens >= maxContextLimit` (regardless of min gate).
  - [x] The emergency (≥98%) override still fires regardless of the min gate.
  - [x] T2/T3 tier-promotion nudges are unaffected by the min gate.
  - [x] A T1 growth nudge still fires when `minContextLimit` is unresolvable (percent limit + unknown model context limit) — growth-only fallback.
- **Performance / Stability**: one boolean OR in the existing decision path — no measurable cost.
- **Regression**:
  - [x] New/modified test cases added to test suite and passing.
  - [x] Existing tests that asserted the old (buggy) below-min growth behavior are updated to set `minContextLimit` below the test context so the growth mechanism is still exercised.

## 6. Proposed Approach

- **Affected modules & entry files**:
  - `lib/messages/inject/utils.ts` — `isContextOverLimits` returns `minLimitResolved` (whether `minContextLimit` resolved to a concrete value).
  - `lib/messages/inject/inject.ts` — `nudgeAllowed` growth path now requires `minGateOpen = !minLimitResolved || overMinLimit || overMaxLimit`.
  - `tests/inject.test.ts` — 7 new min-gate tests (gate, cycle, production config, over-max bypass, unresolvable-limit fallback, emergency bypass, T2 independence); 4 existing tests had `minContextLimit` lowered so they still isolate the growth mechanism (they previously set it above the test context, which the fix now correctly suppresses).
  - `README.md`, `CONFIGURATION.md` — corrected stale `minContextLimit`/`maxContextLimit` defaults (45%/55% → 80%/80%, matching lib/config.ts since v1.14.16) and the min-gate semantics.
- **Risks**: tests that intentionally isolated the growth mechanism by setting a high `minContextLimit` will now need a lower `minContextLimit`; verified by running the full suite. A naive `(overMaxLimit || overMinLimit)` gate regresses models that don't report `limit.context` (percent limits become unresolvable → all growth nudges suppressed); the `minLimitResolved` guard fixes this.
- **Rollback strategy**: single revert commit; no schema/config/data migrations.
