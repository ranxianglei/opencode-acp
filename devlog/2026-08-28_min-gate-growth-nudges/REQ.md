# REQ - Gate T1 growth nudges on the minNudgeContextPercent floor

- Task ID: `2026-08-28_min-gate-growth-nudges`
- Home Repo: `opencode-acp`
- Created: 2026-08-28
- Status: Done
- Priority: P1
- Owner: ework-daemon (qwen3.8-27b)
- References: issue ranxianglei/opencode-acp#342

## 1. Background & Problem Statement

- **Context**: ACP's T1 (message/range) compression nudges should not fire when the working context is too small to be worth compressing. The intended knob for that is `minNudgeContextPercent` (default **15**, a percent of the model context) — the "don't nudge below this" floor. It was plumbed into `computeShouldNudge` but **ignored** by the external trigger policy, so it was a no-op and growth nudges fired at any context size. (`minContextLimit` / `maxContextLimit` are a separate concern — the soft limit-reminder thresholds, both defaulting to **80%**.)
- **Current behavior (symptom)**: T1 *growth* nudges fire well below any configured floor. In the reporter's setup (400K window, `modelMinLimits=150000`, `modelMaxLimits=215000`, `nudgeGrowthTokens=50000`), ten `trigger=growth` nudges fired at 67K–152K tokens. Raising `nudgeGrowthTokens` is not a clean workaround because the same knob drives T2/T3 promotion.
- **Expected behavior**:
  - T1 efficiency (growth) nudge = `currentTokens >= minNudgeContextPercent%×modelContext` AND `growth >= nudgeGrowthTokens` (AND `growth >= growthFloor`).
  - T1 maximum nudge = `currentTokens >= maxContextLimit` (unchanged; bypasses the floor).
  - Emergency (≥ `emergencyThresholdPercent`, default 98%) override unchanged.
  - T2/T3 tier-promotion nudges remain independent of the floor (useful even when working context is small).
- **Impact**: users who tune the floor to defer compression get no such deferral for growth nudges; the model compresses early instead of at the configured floor, wasting compression cycles.

## 2. Reproduction (if applicable)

- **Environment**: opencode-acp 1.14.25, Node 22/24, 400K-context model.
- **Minimal reproduction steps**:
  1. Set `compress.minNudgeContextPercent` above the session's starting context (e.g. 37.5 on a 400K model = 150K floor).
  2. Let context grow by ≥ `nudgeGrowthTokens` while still below the floor.
  3. A `trigger=growth` nudge is injected despite `currentTokens < floor`.
- **Relevant configuration**: `compress.minNudgeContextPercent`, `compress.nudgeGrowthTokens`.

## 3. Root cause

- `computeShouldNudge` (external `context-compress-algorithms/trigger`) computes `shouldNudge = growthSinceLastNudge >= nudgeGrowthTokens || overMaxLimit`. `minNudgeContextPercent` is passed in but **ignored** (deprecated in the policy's param type).
- In `lib/messages/inject/inject.ts`, `nudgeAllowed = emergencyOverride || (decision.shouldNudge && growthSinceBaseline >= growthFloor)` — no context-size floor at all. So growth nudges fire at any context size once the growth threshold is met.
- **Why not `minContextLimit`**: the first revision gated on `overMinLimit`, but `minContextLimit` defaults to **80%** (`lib/config.ts:200`) and is documented as the "soft lower threshold for turn/iteration reminders" (README.md:328-331). Gating growth nudges on it would suppress ALL growth nudges below 80% for default users — effectively disabling compression for most of a session (flagged by @dog in issue #342). The correct floor is the low-default `minNudgeContextPercent` (15%).

## 4. Constraints & Non-Goals

- **Constraints**:
  - The floor must default to a LOW value (`minNudgeContextPercent` = 15%) so default users still get growth nudges throughout a session.
  - When the model context limit is unknown, the floor is unresolvable and growth nudges keep pre-#342 growth-only behavior (no accidental suppression).
  - `overMaxLimit` and the emergency path must be unaffected (they bypass/override the floor).
  - T2/T3 tier-promotion nudges must remain independent of the floor.
  - No new dependencies; no change to the external `context-compress-algorithms` package (fix lives in ACP's `inject.ts`).
  - No change to persisted state format or internal `dcp` tags.
- **Non-Goals** (out of scope):
  - Percentage-based `nudgeGrowthTokens` (issue #300).
  - The broader T1/T2/T3 decision-chain refactor (issue #300).
  - A per-model `modelMinNudgeContextPercent` variant (the floor is a global percent for now; per-model is a follow-up enhancement).
  - Making the max-limit path bypass the `growthFloor` cadence gate (pre-existing, documented anti-thrashing behavior — left as-is per issue #342 discussion).

## 5. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] A T1 growth nudge does NOT fire when `currentTokens < minNudgeContextPercent%×modelContext` (even if `growth >= nudgeGrowthTokens` and `>= growthFloor`).
  - [x] A T1 growth nudge DOES fire when `currentTokens >= floor` and `growth >= nudgeGrowthTokens` and `>= growthFloor`.
  - [x] A T1 maximum nudge still fires when `currentTokens >= maxContextLimit` (bypasses the floor).
  - [x] The emergency (≥98%) override still fires regardless of the floor.
  - [x] When the model context limit is unknown, growth nudges keep pre-#342 behavior (floor unresolvable → no suppression).
  - [x] T2/T3 tier-promotion nudges are unaffected by the floor.
- **Performance / Stability**: one floor check in the existing decision path — no measurable cost.
- **Regression**:
  - [x] New/modified test cases added to test suite and passing (1035 tests, 0 failures).
  - [x] Pre-existing test #27 (context 100K on a 1M model) updated into the [floor, max) range since the dormant 15% floor now suppresses below 150K.
  - [x] Stale README/CONFIGURATION default docs corrected (45%/55% → 80%/80%).

## 6. Proposed Approach

- **Affected modules & entry files**:
  - `lib/messages/inject/inject.ts` — compute `overMinNudgeFloor` from `minNudgeContextPercent` and add `(overMaxLimit || overMinNudgeFloor)` to the `nudgeAllowed` growth path.
  - `lib/messages/inject/utils.ts` — revert the `minLimitResolved` addition (dead code in the floor approach).
  - `tests/inject.test.ts` — 4 floor tests + 2 new (unresolvable model limit, T2 independence); fix pre-existing test #27.
  - `README.md`, `CONFIGURATION.md` — default corrections (from the review commit, preserved).
- **Risks**: activating a previously-dormant field changes default behavior (growth nudges below 15% are now suppressed). Verified against the full suite; the only pre-existing test affected was #27 (100K context on a 1M model).
- **Rollback strategy**: revert the commits; no schema/config/data migrations.
