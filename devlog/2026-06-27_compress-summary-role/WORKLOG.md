# WORKLOG: Fix compression summary causing dialog role confusion (Bug 36)

- Task ID: `2026-06-27_compress-summary-role`
- Branch: `2026-06-27_compress-summary-role`

## Investigation

- Root cause located in `lib/messages/prune.ts` → `filterCompressedRanges`. The compression summary was always created via `createSyntheticUserMessage` (`lib/messages/utils.ts`), hardcoding `role: "user"`. Injected at the start of the pruned range, when the first surviving message was also a user turn the output became `[summary(user), user(user), assistant]`.
- Confirmed anchor placement: `resolveAnchorMessageId` (`lib/compress/search.ts`) returns the **start** message id of the range; `filterCompressedRanges` injects the summary at that position and skips the pruned range.
- Confirmed SDK constraint: `AssistantMessage` (`@opencode-ai/sdk/v2`) requires `parentID, modelID, providerID, mode, path, cost, tokens` — fabricating these is high-risk; the codebase has zero synthetic assistant messages today.

## Design decision

- Consulted Oracle (read-only, 2 passes). First pass recommended adaptive role (Option A). After surfacing the `AssistantMessage` required-fields constraint, Oracle revised to **Option F (merge)**: when the next surviving message is a user turn, prepend the recap into that message instead of emitting a standalone user-role summary; otherwise keep prior behavior. Eliminates the consecutive-user turn structure that mechanically drove the self-Q&A loop, stays inside tested user-role territory, no fabricated message shapes.

## Changes

- `lib/messages/utils.ts`
    - Added `MERGED_SUMMARY_HEADER` / `MERGED_SUMMARY_FOOTER` constants (block-id-scoped delimiter).
    - Added `prependCompressionSummary(message, summary, blockId)` — idempotent prepend into the first text part (creates one if absent); returns false if the block's marker is already present.
- `lib/messages/prune.ts`
    - Imported `prependCompressionSummary`.
    - `filterCompressedRanges`: converted to indexed loop; added `findNextSurvivingMessage`. When the next surviving message is `role: "user"`, merge the summary into it; otherwise retain the prior standalone-synthetic-message behavior (including the `[FIX Bug 1]` fallback for no preceding user message).
- `tests/e2e-message-transform.test.ts`
    - Updated the "compression blocks" test to assert the recap is merged into the following user message (and checks content, not the shared `msg_dcp_summary_` prefix, because the unrelated suffix-guidance nudge reuses that prefix).
    - Added regression test "compression summary: never produces two consecutive user turns (Bug 36)".

## Verification

- `npm run typecheck` — clean (tsc --noEmit, no errors).
- `bun test tests/` — **383 pass, 1 fail**. The single failure (`tests/prompts.test.ts`) is a pre-existing bun-runner limitation ("test() inside another test() is not yet implemented in Bun"); the project's real runner (`node --import tsx --test tests/*.test.ts`) supports nested tests. Unrelated to this change.
- Targeted re-runs: `bun test tests/e2e-message-transform.test.ts` — 12 pass / 0 fail.

## Lessons

- The compression summary's role was an implicit, untested assumption (no test asserted `role: "user"`), yet it drove a real-world failure mode (self-Q&A). The regression test now guards the structural invariant directly (no adjacent user turns).
- Two distinct synthetic messages share the `msg_dcp_summary_` id prefix (compression summary + suffix-guidance nudge) — tests must key off content, not prefix, when asserting absence of one kind.
