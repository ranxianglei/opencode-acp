# REQ - Fix getCurrentTokenUsage underestimation when output=0

- Task ID: `2026-07-14_token-usage-fix`
- Home Repo: `opencode-acp`
- Created: 2026-07-14
- Status: Done
- Priority: P0
- Owner: awork
- References: Gitea issue dog/opencode-acp#20

## 1. Background & Problem Statement

- **Context**: Session `ses_0a3be0cdeffezb9pLzfifH7lzK` hit 1.03M tokens (context full) with 16x API 400 errors, but ACP never triggered compression nudges or GC.
- **Current behavior (symptom)**: `getCurrentTokenUsage()` in `lib/token-utils.ts` skips assistant messages with `output <= 0` (line 17). When recent assistant messages have `output=0` (aborted/hidden agent requests, finish_reason=other), the function falls through to content estimation that only counts text parts. If most content was compressed away, the estimate is ~10% of actual → ACP thinks context is at 10% when it's at 100%+.
- **Expected behavior**: `getCurrentTokenUsage` should use token data from assistant messages that have `input > 0` even when `output = 0`, since `input + cacheRead + cacheWrite` still represents the prompt size sent to the model.
- **Impact**: Context overflow with no compression trigger. Model gets API 400 errors, session becomes unusable.

## 2. Reproduction

- **Environment**: GLM-5.2 model, 1M context limit, long sessions with aborted agent requests.
- **Minimal reproduction steps**:
    1. Have a session where recent assistant messages have `output=0` (from hidden agent requests/aborts)
    2. Context grows past the configured limit
    3. ACP never fires nudges because it underestimates usage by 10x
- **Relevant configuration**: `minContextLimit: "20%"`, `maxContextLimit: "20%"` on 1M model.

## 3. Constraints & Non-Goals

- **Constraints**: Backward compatible — existing tests must still pass. No change to the token formula (`input + cacheRead + cacheWrite + output + reasoning`).
- **Non-Goals**: Not changing the GC system (deprecated). Not changing config defaults.

## 4. Acceptance Criteria

- **Correctness**:
    - [x] Assistant messages with `output=0, input>0` are used (not skipped)
    - [x] Assistant messages with `output=0, input=0` are still skipped (truly empty)
    - [x] Compaction check still works (stale messages return 0)
    - [x] Fallback estimation includes tool outputs, not just text
- **Regression**:
    - [x] All 669 tests pass (4 existing + 3 new)

## 5. Proposed Approach

- **Affected modules**: `lib/token-utils.ts`, `tests/token-usage.test.ts`
- **Changes**:
    1. Change skip condition from `output <= 0` to `input <= 0 && output <= 0`
    2. Change fallback from text-only to `countAllMessageTokens` (text + tool outputs)
- **Risks**: Minimal — the token formula is unchanged, only the message selection condition widened.
