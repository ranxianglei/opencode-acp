# REQ - Skip nudge when filter has no recommendations

- Task ID: `2026-07-15_nudge-no-recs-skip`
- Home Repo: `opencode-acp`
- Created: 2026-07-15
- Status: Done
- Priority: P1
- Owner: sisyphus
- References: issue #20

## 1. Background & Problem Statement

- **Context**: v1.12.7 introduced `filterRecommendedRanges` to exclude ranges below the last-segment floor from the recommendation list.
- **Current behavior (symptom)**: When all ranges are filtered out (no recommendations), the nudge still fires — injecting "go compress" text with an empty recommendation list. The model sees the nudge but has nothing actionable to compress.
- **Expected behavior**: Nudge text injection should be suppressed when the filter removed all ranges. Emergency overrides (maxLimit) always inject.
- **Impact**: Model gets confused by a nudge with no recommendations. Wastes context tokens.

## 2. Reproduction (if applicable)

- **Environment**:
  - Session `ses_09c3c1da9ffeZLZW3UnJs5pYG1`
  - Model: glm-5.2 (1M context)
- **Minimal reproduction steps**:
  1. Context grows past growth threshold (50K for 1M model)
  2. All compressible ranges are below last-segment floor (100K for 1M model)
  3. Nudge fires with empty recommendation list
- **Relevant configuration**: Default config, `modelContextLimit: 1000000`

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: Tests without message IDs (no ranges at all) should still nudge normally
  - Emergency override (maxLimit) must always inject regardless of filter
- **Non-Goals**: Changing the filter logic itself; changing nudge threshold mechanics

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] Nudge suppressed when ranges exist but filter removed all
  - [x] Nudge fires normally when no ranges exist (no message IDs)
  - [x] Emergency override fires even when filter has no recommendations
- **Regression**:
  - [x] New/modified test cases added to test suite and passing

## 5. Proposed Approach (optional)

- **Affected modules & entry files**: `lib/messages/inject/inject.ts`
- **Risks**: Low — only changes the nudge injection gate condition
- **Rollback strategy**: Revert the `filterSuppressed` gate change
