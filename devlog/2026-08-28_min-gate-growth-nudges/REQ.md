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
  - Backward compatibility: default config always sets `minContextLimit` (45%), so default users keep a defined gate. `overMaxLimit` and emergency paths must be unaffected (they imply/override the min gate).
  - T2/T3 tier-promotion nudges must remain independent of `minContextLimit`.
  - No new dependencies; no change to the external `context-compress-algorithms` package (fix lives in ACP's `inject.ts`).
  - No change to persisted state format or internal `dcp` tags.
- **Non-Goals** (out of scope):
  - Percentage-based `nudgeGrowthTokens` (issue #300).
  - The broader T1/T2/T3 decision-chain refactor (issue #300).
  - Adding a separate "T1 growth floor" config knob (the user offered it as an alternative; the min-gate is the narrower, documented fix).

## 5. Acceptance Criteria (must be testable)

- **Correctness**:
  - [ ] A T1 growth nudge does NOT fire when `currentTokens < minContextLimit` (even if `growth >= nudgeGrowthTokens` and `>= growthFloor`).
  - [ ] A T1 growth nudge DOES fire when `currentTokens >= minContextLimit` and `growth >= nudgeGrowthTokens` and `>= growthFloor`.
  - [ ] A T1 maximum nudge still fires when `currentTokens >= maxContextLimit` (regardless of min gate).
  - [ ] The emergency (≥98%) override still fires regardless of the min gate.
  - [ ] T2/T3 tier-promotion nudges are unaffected by the min gate.
- **Performance / Stability**: one boolean OR in the existing decision path — no measurable cost.
- **Regression**:
  - [ ] New/modified test cases added to test suite and passing.
  - [ ] Existing tests that asserted the old (buggy) below-min growth behavior are updated to set `minContextLimit` below the test context so the growth mechanism is still exercised.

## 6. Proposed Approach

- **Affected modules & entry files**:
  - `lib/messages/inject/inject.ts` — add `(overMaxLimit || overMinLimit)` to the `nudgeAllowed` growth path.
  - `tests/inject.test.ts` — fix the one test that set `minContextLimit` above the test context; add new min-gate tests.
- **Risks**: tests that intentionally isolated the growth mechanism by setting a high `minContextLimit` will now need a lower `minContextLimit`; verified by running the full suite.
- **Rollback strategy**: single revert commit; no schema/config/data migrations.
