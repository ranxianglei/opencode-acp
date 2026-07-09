# REQ - toolOutput reminder must scale with context (5% protection bypass)

- Task ID: `2026-07-09_tooloutput-nudge-adaptive`
- Home Repo: `opencode-acp`
- Created: 2026-07-09
- Status: InProgress
- Priority: P1
- Owner: awork
- References: Gitea dog/opencode-acp#18

## 1. Background & Problem Statement

- **Context**: ACP exposes two independent nudge mechanisms that encourage the
  model to compress:
  1. The **growth nudge** (`computeShouldNudge`) — fires every `nudgeGrowthTokens`
     of context growth. `nudgeGrowthTokens` is adaptive: 5% of the model's
     context limit, clamped to `[6000, 50000]` (see `lib/messages/inject/utils.ts`,
     `NUDGE_GROWTH_RATIO = 0.05`). For a 1M-context model this is **50000 tokens**.
  2. The **toolOutput reminder** — fires when tool-output growth crosses
     `toolOutputThreshold`. This is the "⚠️ N new tool outputs accumulated ...
     Use compress tool to compress these ranges now." directive.
- **Current behavior (symptom)**: The toolOutput reminder uses a **hardcoded**
  `5000`-token threshold (`inject.ts:204`, `config.compress?.toolOutputNudgeThreshold ?? 5000`).
  On a 1M-context model, 5000 tokens is **0.5%** of context — ~10× more
  sensitive than the growth nudge's 5% (50000 tokens). The reminder fires
  independently of `decision.shouldNudge` and is injected into the suffix even
  when the growth gate says "do not nudge", so it effectively **bypasses the 5%
  protection**.
- **Expected behavior**: The toolOutput reminder threshold must scale with
  context size, reusing the same adaptive `nudgeGrowthTokens` value by default.
- **Impact**: In the reported session `ses_0c2244c0bffeChX2cflIq4jrVz` (1M model),
  this drove **68 compressions across 499 LLM calls** (~1 per 7 calls) while
  context never exceeded **22.6%** of the limit (peak 226K of 1M; the 45% min /
  55% max limits were never approached). The model was being pushed to
  over-compress aggressively. The bug reproduced live during investigation (the
  reminder fired at 7% / 9% context).

### Secondary finding
`compress.toolOutputNudgeThreshold` was **dead config** — declared in the
`CompressConfig` type (`lib/config.ts:29`) but absent from `mergeCompress`
return, `VALID_CONFIG_KEYS`, and `dcp.schema.json`. Any user override was
silently dropped, so `?? 5000` always won.

## 2. Reproduction

- **Environment**: 1M-context model (e.g. Gemini-class). Long session with heavy
  tool traffic (bash/read/write).
- **Minimal reproduction**:
  1. Start a session on a 1M model.
  2. Accumulate >5000 tokens of new tool output in a turn.
  3. Observe the "⚠️ N new tool outputs accumulated ... compress these ranges
     now." directive injected into the suffix — even though context usage is far
     below the 45% min limit.
- **Evidence**: `acp-inspect ses_0c2244c0bffeChX2cflIq4jrVz --stats` → 68
  compressions; persisted nudge state has empty limit/turn/iteration anchors but
  a non-empty `lastToolOutputNudgeTokens` tracking repeated tool-reminder firing.

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: existing `toolOutputNudgeThreshold` config field is
    already in the type (opt-in); wiring it up is purely additive. No persisted
    state format change. Internal `dcp` naming preserved.
  - Performance: trivial (one `??` swap + config plumbing).
- **Non-Goals** (explicitly out of scope):
  - Persisting `state.modelContextLimit` (separate issue: on first turn / after
    restart it is `undefined`, so the adaptive growth falls to the 6000 floor
    until the system-prompt hook populates it). Aggravates but is not the root
    cause of #18.
  - Re-architecting the dual-nudge system.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] On a 1M model, tool-output growth of ~9K tokens does NOT fire the
        toolOutput reminder (regression: old hardcoded 5000 would fire).
  - [x] Tool-output growth that crosses the adaptive threshold (~50K for 1M)
        DOES fire the reminder.
  - [x] An explicit `compress.toolOutputNudgeThreshold` override is respected
        and flows through config merge.
  - [x] `toolOutputNudgeThreshold` is a recognized config key (not flagged
        unknown by `getInvalidConfigKeys`) and present in the JSON schema.
- **Regression**:
  - [x] New test cases added to `tests/inject.test.ts` (3) and
        `tests/config-validation.test.ts` (1), all passing.

## 5. Proposed Approach

- **Affected modules & entry files**:
  - `lib/messages/inject/inject.ts` — threshold default `5000` → `nudgeGrowthTokens`.
  - `lib/config.ts` — wire `toolOutputNudgeThreshold` through `mergeCompress`.
  - `lib/config-validation.ts` — add to `VALID_CONFIG_KEYS`.
  - `dcp.schema.json` — declare the property.
- **Risks**: Low. Default behavior changes (fires less often) — this is the
  intended fix. Users who relied on the dead override are unaffected (it was
  previously ignored).
- **Rollback strategy**: Revert the single commit.
