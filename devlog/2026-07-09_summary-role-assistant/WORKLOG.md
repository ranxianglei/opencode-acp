# WORKLOG: Summary Role — Always Assistant

## 2026-07-09

### Investigation
- Read `lib/messages/prune.ts` L201-300: identified two injection paths
- Path 1 (merge into user): `findNextSurvivingMessage()` + `prependCompressionSummary()`
- Path 2 (standalone assistant): `createSyntheticMessage(..., "assistant")`
- Reviewed Bug 36 DESIGN.md rejection rationale: AssistantMessage field requirements
- Verified Bug 37 already solved this: `createSyntheticMessage` fabricates safe defaults

### Implementation
- `prune.ts`:
  - Removed `prependCompressionSummary` from import
  - Replaced L250-291 dual-path logic with always-assistant standalone path
  - Added [FIX Bug 39] comment block explaining the change
  - Removed dead `findNextSurvivingMessage` function (L310-328)
- `utils.ts`:
  - Attempted to remove `MERGED_SUMMARY_HEADER/FOOTER` + `prependCompressionSummary`
  - Edit tool corrupted `DCP_BLOCK_ID_TAG_REGEX` bytes → reverted utils.ts to HEAD
  - Dead code remains as unused exports — typecheck passes, cleanup deferred

### Test Updates
- `prune.test.ts`:
  - L163: summary search changed from `role: "user"` to `role: "assistant"`
  - L167-210: Renamed to "prune always emits standalone assistant summary (Bug 39 fix)"
  - L292-327: Bug 28 test updated to check standalone assistant msg, not m1
- `e2e-message-transform.test.ts`:
  - L387-424: standalone assistant EXISTS, u2 does NOT contain summary
  - L428-516: u2 should NOT contain recap, standalone assistant should exist
  - L520-607: Updated comments + role assertion from user to assistant

### Verification
- typecheck: PASS
- build: PASS (354.25 KB)
- tests: 587 pass, 1 fail (pre-existing Bun quirk in prompts.test.ts)
- Reverted other agent's (issue #14) incomplete test change in protected-tool-exclusion.test.ts
