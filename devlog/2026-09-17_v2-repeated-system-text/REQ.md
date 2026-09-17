# REQ - Map Repeated Identical V2 System Text by Ordered Occurrence

- Task ID: `2026-09-17_v2-repeated-system-text`
- Home Repo: `opencode-acp`
- Created: 2026-09-17
- Status: InProgress
- Priority: P1
- References: https://github.com/ranxianglei/opencode-acp/issues/422 (related: #418, #419, #395)

## 1. Background & Problem Statement

- **Context**: ACP normalizes V2 projected history against the provider's lowered
  outgoing messages (`normalizeV2ProjectedHistory`) before applying a
  provenance-validated patch. System sources are correlated to their lowered
  counterpart because OpenCode's `toLLMMessages` lowering emits system messages
  WITHOUT preserving the projected record ID.
- **Current behavior (symptom)**: When a session legitimately contains two or more
  projected system records with distinct IDs but identical text, the lowered
  outgoing array contains N identical ID-less system messages. The system branch in
  `lib/v2/projection/normalize.ts` computed the unclaimed candidates for that text
  and rejected the whole projection when more than one remained
  (`System source <id> has multiple lowered origins`). A valid host sequence was
  treated as ambiguity.
- **Expected behavior**: Correlate repeated identical system text by verified
  ordered occurrence — the k-th projected record claims the k-th unclaimed lowered
  match in lowering order — instead of rejecting. A record with no remaining
  lowered match stays opaque and unmapped; ownership is never guessed and no
  system message is dropped. Non-system destructive-edit rejections are unchanged.
- **Impact**: One repeated system text rejected the entire projection, skipping
  pruning/ID/nudge injection and preventing fresh session initialization from
  committing state. Confirmed live immediately after the #418 fix activated (#418
  floor 5).

## 2. Reproduction

- **Environment**: OpenCode V2 `2.0.3` (d44b52c), Linux, dual-runtime fork
  `drexb-ops/opencode-acp@1fe36e0`.
- **Minimal reproduction**:
    1. Lower two valid projected system messages with distinct IDs and identical
       text using official `toLLMMessages`; OpenCode emits two
       `Message.system(text)` values without IDs.
    2. Pass the projected and lowered arrays to `normalizeV2ProjectedHistory`.
    3. Observe `valid: false`, `System source s1 has multiple lowered origins`.
- **Relevant configuration**: V2 server plugin loaded through the normal
  `opencode.json` `plugins` array. No config change required.

## 3. Constraints & Non-Goals

- **Constraints**:
    - Preserve V1 behavior, persistent-state schema, and internal `dcp-*` tags.
    - Never guess ownership of an ambiguous system message and never drop one.
    - Fail closed on genuinely ambiguous *patchable* (non-system) destructive edits.
    - Use only public OpenCode V2.0.3 APIs and add no dependency.
- **Non-Goals**:
    - Changing OpenCode's lowering of system message IDs.
    - Relaxing any non-system correlation rejection.
    - Changing CLI configuration or TUI-only plugin behavior.

## 4. Acceptance Criteria

- **Correctness**:
    - [x] Genuine host-lowered repeated identical system messages map by ordered
          occurrence (k-th projected -> k-th unclaimed lowered match) with
          `valid: true` and no rejection.
    - [x] Interleaved histories preserve per-text occurrence order: the second
          identical record maps to the second matching lowered message, not the first.
    - [x] Extra host-added system messages are left unclaimed without rejecting,
          whether they duplicate a projected text or introduce a new one.
    - [x] Truly ambiguous *patchable* (non-system) sources still reject
          (`Patchable origin ... has no exact lowered outgoing match`).
    - [x] A fresh registry commits for a session whose history repeats identical
          system text, and a subsequent direct compression is reachable on that
          committed state.
- **Regression**:
    - [x] New unit tests in `tests/v2-context-patch.test.ts` and a V2 context test
          in `tests/v2-context.test.ts` added; each new "should now be valid" case
          verified to FAIL against the pre-fix code (revert-and-run).
    - [x] Full test suite, typecheck, build, package verification, targeted
          formatting, and diff checks pass.

## 5. Proposed Approach

- **Affected modules**: `lib/v2/projection/normalize.ts` (system branch of the
  draft->outgoing-index mapping loop) and V2 projection/context tests.
- **Approach**: Remove the premature multi-candidate rejection for system sources.
  The existing `outgoingSystem(text, map, claimed)` helper already performs greedy
  ordered claiming (first unclaimed lowered index for that text), so simply calling
  it per projected record yields correct k-th-to-k-th mapping while leaving all
  non-system rejection paths untouched.
- **Risks**: None identified beyond correctness of the claiming order; mitigated by
  ordered-occurrence unit tests plus a fail-closed guard test.
- **Rollback**: Revert this branch's fix commit; no migration is required (no
  persisted-state or config-schema change).
