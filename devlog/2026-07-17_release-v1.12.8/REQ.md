# REQ: Release v1.12.8 (stable)

## Goal

Ship the phantom-block rejection guard (PR #148) to stable.

## Changes (1 PR since v1.12.7)

1. **PR #148 — Reject empty/phantom blocks (`checkPhantomBlock`)**
   - New stateless pre-check in `lib/compress/pipeline.ts` that mirrors `applyCompressionState`'s `newlyCompressedMessageIds` computation.
   - For each compress plan: builds effective message set (plan messages + consumed blocks' effective messages), checks if ANY message is "new" (no active block covering it BEFORE mutation). If none new → phantom → reject entire call with clear error before any state mutation.
   - Wired into range-mode (`compress/range.ts`) and message-mode (`compress/message.ts`) after plan preparation.
   - Fixes the phantom-block death loop (#93, #135): model compressing an already-compressed range no longer creates a 0-token block + summary overhead that grows context.

## Version

1.12.7 → 1.12.8
