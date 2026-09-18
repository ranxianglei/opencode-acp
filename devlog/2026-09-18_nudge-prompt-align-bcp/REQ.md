# REQ - Align nudge/system prompt discipline with billion-context-pi (no speculative acp_status pre-check)

- Task ID: `2026-09-18_nudge-prompt-align-bcp`
- Home Repo: `opencode-acp`
- Created: 2026-09-18
- Status: InProgress
- Priority: P1
- Owner: ranxianglei
- References: https://github.com/ranxianglei/opencode-acp/issues/436 ; billion-context-pi `src/system-prompt.ts` + acp-kernel `src/nudge-text.ts` (v0.0.69, pinned by bcp 0.1.71)

## 1. Background & Problem Statement

- **Context**: With `compress.candidates` enabled, ACP lists executor-validated MICRO/EPISODE candidates in compression nudges. The cost of each extra model round trip on local models is 15–23s, so any prompt wording that makes the model call `acp_status` *before* compressing adds a full redundant inference turn per compression event.
- **Current behavior (symptom)**: The standing prompt and nudge guidance actively induce a pre-check turn:
  - `lib/prompts/context-limit-nudge.ts` (CANDIDATE_GUIDANCE): "Use `acp_status` for a fresh candidate view if the list is stale or missing."
  - `lib/prompts/system.ts` (COMPRESSION CANDIDATES section): "call `acp_status` for a fresh view."
  - `lib/prompts/system.ts` (MULTI-TIER section): "If you are unsure which `mNNNNN` refs are still compressible … call `acp_status` first."
  - `lib/prompts/compress-range.ts` (CANDIDATE GUIDANCE): "use `acp_status` when the candidate list is stale."
  Observed in the field: nudge → `acp_status` → `compress` (two tool turns) instead of nudge → `compress` (one).
- **Expected behavior**: The nudged candidate list is authoritative — the model submits it directly with `compress`. `acp_status` remains available as an optional diagnostic/refresh path but is only mandated in two narrow cases: verifying stale refs from past compress calls, and recovering from a failed `compress` call (re-issue in the same turn using only reported refs).
- **Impact**: One full local-model inference turn (tens of seconds on large contexts) saved per compression event; also reduces prompt-prefix invalidation churn since fewer small intermediate turns occur.

## 2. Evidence / Prior Art

- billion-context-pi (bcp 0.1.71) ships acp-kernel 0.0.69 whose prompt design already avoids this round trip:
  - Kernel nudge text (`renderNudgeText`) lists actionable ranges with exact refs + "Compress all ranges in one call" and contains **zero** `acp_status` mentions.
  - bcp standing prompt restricts `acp_status` to (a) not reusing historical refs without verification, and (b) failure recovery ("run acp_status, then re-issue the compress in the same turn using only the refs it reports").
- opencode-acp already has the stronger property bcp lacks: candidates are pre-validated against the real range executor at nudge construction (`planCompressionCandidates()` → `prepareExecutableRangePlans()`, `lib/messages/inject/candidates.ts`). So only the prompt discipline needs porting — no new arming/validation mechanism required.
- Ref semantics differ from kernel: opencode-acp refs are sticky per raw message ID (`lib/message-ids.ts` keeps existing refs), so the kernel sentence "Every successful compress renumbers the remaining refs" was deliberately NOT ported verbatim; the ported recovery line is phrased generically ("fails because a ref is stale or unknown") to match opencode-acp's actual error paths.

## 3. Constraints & Non-Goals

- **Constraints**:
  - Prompt-only change: no changes to validation, state, or tool behavior. `acp_status` stays fully functional as a diagnostic tool.
  - Both modes covered: candidates-on wording lives in candidate sections; the removed MULTI-TIER hedge applied to both modes (it was mode-independent).
  - Keep existing test-pinned sentences that remain valid ("suggestions, not mandatory targets", "call the `compress` tool in your next reply", "structurally safe to submit, not a command to compress").
- **Non-Goals**: no "arming" of canonical ranges in SessionState (#436's proposed mechanism deemed unnecessary once prompt discipline matches pi-side); no changes to `acp_status` output format; no version bump (release branch only).

## 4. Acceptance Criteria

- **Correctness**:
  - [ ] No prompt text tells the model to call `acp_status` before compressing listed candidates/ranges (no "fresh view"/"call acp_status first" hedging remains in system/nudge/compress prompts).
  - [ ] Failure-recovery guidance present: failed compress → run `acp_status` → re-issue in the same turn using only reported refs, batched in one call.
  - [ ] Candidates-mode nudge states listed candidates were validated at nudge build time and can be compressed directly.
- **Performance / Stability**:
  - [ ] `npm run typecheck`, `npm run format:check`, full test suite green.
- **Regression** (AGENTS.md §5.7):
  - [ ] Constant-level regression tests pinning new wording + absence of old hedging.
  - [ ] Multi-turn `injectCompressNudges` test (shared SessionState, ≥2 consecutive turns) asserting both `shouldInjectThisTurn` and `lastPerMessageNudgeTokens` after each turn, rendered nudge carries the new direct-action guidance, and one variant uses production-style `preserveRecentMessages > 0`.

## 5. Proposed Approach

- **Affected files**:
  - `lib/prompts/context-limit-nudge.ts` — replace "fresh candidate view" hedge with validated-directly + post-failure wording.
  - `lib/prompts/system.ts` — (a) COMPRESSION CANDIDATES bullet: validated-at-build-time + "do not call acp_status first"; (b) add failure-recovery bullet under COMPRESSION SUMMARIES IN CONTEXT; (c) delete the MULTI-TIER "call acp_status first" paragraph.
  - `lib/prompts/compress-range.ts` — CANDIDATE GUIDANCE tail: no pre-check; post-failure recovery instead of "use acp_status when stale".
  - `tests/nudge-text.test.ts`, `tests/compression-candidates.test.ts` — regression + multi-turn tests.
- **Verification**: typecheck + full suite + dev-deploy smoke check of rendered nudge text.
