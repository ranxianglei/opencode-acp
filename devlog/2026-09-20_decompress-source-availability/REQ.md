# REQ: decompress must verify source-message availability before committing

- **Issue**: https://github.com/ranxianglei/opencode-acp/issues/446
- **Branch**: `2026-09-20_decompress-source-availability`
- **Date**: 2026-09-20
- **Type**: Bug fix

## Problem

When an indexed original message is absent from the history returned by the host
(native compaction, external deletion, V2 checkpoint divergence), block decompression
still reports `Restored N message(s)`, deactivates the summary block, and decrements
`totalPruneTokens` — restoring visibility metadata without verifying that any content
actually returns to context.

Verified trace on master (`f6c70a7e` era, v1.18.x):

1. `lib/compress/decompress.ts:340` — `snapshotActiveMessages` snapshots indexed IDs, not fetched originals.
2. `lib/compress/decompress.ts:343-347` — deactivates targets + `syncCompressionBlocks`.
3. `lib/messages/sync.ts:136-146` — membership update never intersects with available history IDs.
4. `lib/compress/decompress-logic.ts:162-177` — `computeRestoredMessages` counts membership transitions only; does not accept rawMessages.
5. `lib/compress/decompress.ts:358-361,382-384` — stats adjusted + success message emitted.
6. Preview (`decompress-logic.ts:191-231`) reads real history; empty when originals missing; `decompress.ts:395-399` silently omits it. No warning.

Repro fixture (issue #446): active b5 covers `msg-gone`;
`byMessageId["msg-gone"] = { tokenCount: 100, allBlockIds: [5], activeBlockIds: [5] }`;
history contains a different message. Observed pre-fix:
`restoredMessageCount: 1, restoredTokens: 100, actualOriginalMessagesFound: 0, restoredContentPreview: "", blockDeactivated: true`.

## Why it matters

- **False success**: model believes "restored" content is visible → hallucination risk about details that are not in context.
- **Stats corruption**: `totalPruneTokens` decremented by phantom tokens → `/acp context` lies.
- **Irreversible coverage loss**: user-deactivated blocks are terminal (sync keeps them dead); if the summary carrier (compress tool call) was also removed from history, the content is unrecoverable after a blind deactivation.

## Acceptance criteria (from issue)

1. Verify required source messages are present before committing a decompression that claims to restore originals, respecting one-tier vs full semantics.
2. Return explicit complete/partial/missing-source results with missing IDs/counts; do not label metadata-only restoration as recovered text.
3. Preserve usable summary coverage on unavailable originals (fail closed), unless an explicit policy deliberately permits partial restoration.
4. Count restored originals / adjust statistics based on verified recovered content, not only membership transitions.
5. Integration regressions: all originals missing, partial availability, complete availability, nested one-tier/full cases.
6. Distinguish transient host-fetch failures (error before any mutation) from missing/deleted originals (gate aborts, no state change).

## Scope

- In scope: normal non-toFile block/range decompression path (`createDecompressTool.execute`).
- Out of scope: toFile export field bugs (#445), V2 host-history projection (#425), retry logic for fetch failures (fetch failure already errors before any mutation — documented, no new mechanism).
