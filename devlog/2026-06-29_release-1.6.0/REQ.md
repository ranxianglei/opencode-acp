# REQ: Release v1.6.0

## Background
PR #36 (context optimization) merged to master. Need to publish npm v1.6.0 with all changes.

## Changes in v1.6.0 (since v1.5.1)
1. Two-tier summary length limits (soft 200 / hard 800)
2. Minimum compress range (2000 chars)
3. Step marker truncation (step-start skipped, step-finish ~50 chars)
4. Nudge strengthening + directive consolidation guidance
5. mark_block + unmark_block removed from model tools
6. Auto-detect consumed blocks in compress (Plan B)
7. Directive nudge range fix (anchorMessageId, visible range filter)
8. GC simplified to hardcoded 100% fallback
9. README updated (English + Chinese)

## Version Bump
- 1.5.1 → 1.6.0
- Minor version bump: significant feature changes (tool removal, new auto-detection, config options)
