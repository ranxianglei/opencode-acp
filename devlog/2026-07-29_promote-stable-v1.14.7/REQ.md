# REQ: Promote v1.14.7 to npm stable tag

## Purpose
First stable promotion. Marks v1.14.7 as the battle-tested `stable` release.

## Version: 1.14.7

## What changed since initial release (key milestones in v1.14.x series):

### v1.14.7
- Deduplicate HOW_TO_COMPRESS_RULES — saves 2.4-3.6K tokens per nudge turn

### v1.14.6
- Debug nudge chat visibility — debug mode persists nudge text to chat UI

### v1.14.5
- GC module removal (4 data-loss bugs fixed) + emergency tool output truncation
- Dead code removal (~2309 lines: prune tool, sweep, strategies)
- Property-based tests (10 invariants, ~1400 random inputs)
- Issue #176 fix: nudge permanently stops after compress in autonomous sessions
- Config documentation (CONFIGURATION.md + zh-CN)

### v1.14.4
- Tier detection fix (PR #215)
- E2E test expansion (8 scenarios, CI)
- Debug notification (PR #217)
- Nudge loop fix (Issue #216, PR #218)

### v1.14.3
- Soften protected zone — convert hard-reject to soft-filter
- Reduce defaults: preserveRecentMessages 20→5, preserveRecentTokens 20000→5000

### v1.14.2
- Split protected ranges at boundary
- Soften last-user-message from hard-reject to soft-filter

### v1.14.1
- Log version info in debug logs
- Growth baseline fix (nothingToCompress feedback loop)

### v1.14.0
- Three-tier LSM-tree compression (T1 capture → T2 distill → T3 condense)
- Preserve-recent messages/tokens protection
- Summary visibility fix (summaryBuffer over-counting)

## Why stable
v1.14.x series has been tested across multiple real engineering sessions with:
- 917+ unit tests, 0 failures
- 10 E2E scenarios in CI
- Property-based testing (fast-check, ~1400 random inputs)
- Dual-agent review on all source changes
- GC data-loss bugs eliminated
- Autonomous session nudge loop fixed
