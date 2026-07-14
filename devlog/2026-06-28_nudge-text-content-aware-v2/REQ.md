# REQ - Nudge Text: Content-Aware v2

- Task ID: `2026-06-28_nudge-text-content-aware-v2`
- Home Repo: `opencode-acp`
- Created: 2026-06-28
- Status: InProgress
- Priority: P1
- Owner: ranxianglei
- References: Gitea issue dog/tasks#30

## 1. Background & Problem Statement

- **Context**: ACP injects compression nudges into the conversation at different context-pressure
  levels (per-message indicator, turn nudge, context-limit nudge, block-aging guidance). These
  nudges steer the model on when and what to compress.
- **Current behavior (symptom)**: The low-pressure per-message guidance read
  "Context is ample — focus on your task. Only compress obvious waste." This caused models to
  treat low context levels as a "do not compress" signal. Large completed tool outputs (build
  logs, diffs, directory listings) sat uncompressed even when no longer needed, inflating token
  consumption 3–5× above necessary. Models also spent reasoning tokens deliberating about
  _whether_ to compress instead of acting.
- **Expected behavior**: Models proactively compress large tool outputs at _any_ context level,
  using `decompress` as a safety net when details are needed later. Nudge text should convey a
  principle ("Be frugal, compress proactively, extract and keep what matters") rather than
  threshold-driven permission gates that the model can see.
- **Impact**: Token consumption 3–5× higher than necessary; wasted attention on
  compression-vs-not deliberation instead of the actual task.

## 2. Reproduction (if applicable)

- **Environment**:
    - Node: LTS (tsx runtime for tests)
    - OS/Arch: linux-arm64
- **Minimal reproduction steps**:
    1. Run any long session with large tool outputs (build/test logs, diffs).
    2. Observe model behavior at <45% context: model keeps verbose tool outputs uncompressed,
       citing "ample context".
    3. Compare token spend against an equivalent session with proactive compression.
- **Relevant configuration**: default `compress.minContextLimit=45%`,
  `compress.maxContextLimit=55%`.

## 3. Constraints & Non-Goals

- **Constraints**:
    - Backward compatibility: No change to nudge injection _logic_, anchor mechanics, or config
      schema — text-only changes to the nudge strings and per-message guidance.
    - Performance requirements: None (text constants, no new computation on hot path).
    - Resource limits: None.
- **Non-Goals** (explicitly out of scope):
    - Changing nudge injection timing, frequency, or anchor selection.
    - Changing threshold semantics or the `minContextLimit` / `maxContextLimit` config values.
    - Altering the block-aging GC warning logic (only its co-existence with the new text).

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
    - [ ] Per-message guidance says "Be frugal" (not "ample")
    - [ ] No threshold numbers (e.g. `45%`, `55%`) are visible to the model in the guidance text
    - [ ] Block ID list shows a summary format (`+N older, use decompress to access by ID`) when
          there are more than 20 active blocks
    - [ ] Preservation rules use "extract and keep what matters" wording (not "preserve verbatim")
    - [ ] All nudges (turn, context-limit, per-message, block guidance) mention the `decompress`
          safety net
- **Performance / Stability**:
    - [ ] No new computation introduced (text-only changes)
- **Regression**:
    - [ ] `npm run typecheck` passes
    - [ ] `npm run test` passes (existing tests + new `tests/nudge-text.test.ts`)
    - [ ] `npm run format:check` passes

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
    - `lib/messages/inject/utils.ts` — per-message context indicator
    - `lib/prompts/system.ts` — system prompt pressure-level descriptions
    - `lib/prompts/extensions/nudge.ts` — compressed-block guidance (block ID summary format)
    - `lib/prompts/turn-nudge.ts` — turn nudge text
    - `lib/prompts/context-limit-nudge.ts` — context-limit nudge text
- **Risks**: Low. Text-only changes; a model could now over-compress, but `decompress` makes
  this reversible and the system prompt still instructs selective compression.
- **Rollback strategy**: Revert the five-file changeset; no data or config migration involved.
