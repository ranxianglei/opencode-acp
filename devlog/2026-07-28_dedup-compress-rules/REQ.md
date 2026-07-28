# REQ: Deduplicate HOW_TO_COMPRESS_RULES

## Problem

`HOW_TO_COMPRESS_RULES` (~1.2K tokens) was injected **multiple times per nudge turn**:

1. **System prompt** (`prompts/system.ts:58`) — always present (1x)
2. **Nudge templates** (`turn-nudge.ts`, `iteration-nudge.ts`, `context-limit-nudge.ts`) — each containing `${HOW_TO_COMPRESS_RULES}`, appended to suffix message via `applyAnchoredNudges` (1-2x)
3. **Breakdown block** (`inject.ts:535-537`) — appended `HOW_TO_COMPRESS_RULES` to the same suffix message when `effectiveTipsVariant !== "maxLimit"` (1x)

In non-maxLimit scenarios, the suffix message contained `HOW_TO_COMPRESS_RULES` **2-3 times** (from nudge templates + breakdown). Combined with the system prompt copy, the model saw the same ~1.2K-token rules block **3-4 times per turn** — wasting **2.4-3.6K tokens per nudge**.

The duplication became visible in v1.14.6 which persists debug nudge text to the chat UI (PR #227).

## Fix

Remove `HOW_TO_COMPRESS_RULES` from:
- `lib/messages/inject/inject.ts:535-537` — breakdown duplication (redundant with nudge templates)
- `lib/prompts/turn-nudge.ts` — template copy
- `lib/prompts/iteration-nudge.ts` — template copy
- `lib/prompts/context-limit-nudge.ts` — template copy

Keep in:
- `lib/prompts/system.ts:58` — system prompt always has the full rules (single source of truth)
- `lib/compress/quality-gate/rejection.ts:68` — rejection message needs full rules for retry guidance

## Acceptance Criteria

- [x] `HOW_TO_COMPRESS_RULES` appears exactly once per turn (in system prompt)
- [x] No type errors
- [x] All 917 tests pass
- [x] Build succeeds
