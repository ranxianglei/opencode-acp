# WORKLOG: Fix Issue #247 — Tool Pair Integrity

## 2026-07-30

### Investigation
- Read `compress/search.ts` (507 lines): `resolveBoundaryIds` resolves boundaries purely by message ID, no tool pair awareness
- Read `messages/prune.ts` (90 lines): `filterCompressedRanges` removes compressed messages, no tool pair check
- Read `messages/query.ts` (96 lines): confirmed `callID` is the linking field for tool calls
- Confirmed: `grep -r 'tool_use|tool_result|toolUse|toolResult' lib/` = 0 matches
- Existing `resolveSelection` already collects `callID`s from tool parts (line 222-231), confirming same callID appears in both assistant (tool_use) and user (tool_result) messages

### Implementation
- Added `adjustBoundariesForToolPairs` to `search.ts` (~60 lines)
  - Collects callIDs in range, scans forward/backward for paired messages
  - Scan limit: 20 messages in each direction
  - Stop-on-gap: breaks at first non-matching message after finding at least one match
- Integrated in `resolveBoundaryIds` after auto-swap (Bug 34 fix), before return
- When indices change, creates new `BoundaryReference` with updated `rawIndex` + `messageId`

### Tests
- Created `tests/tool-pair-integrity.test.ts` with 9 tests:
  1. Forward extension (tool_use at endIdx, tool_result at endIdx+1)
  2. Backward extension (tool_result at startIdx, tool_use at startIdx-1)
  3. No extension when pair is inside range
  4. No extension when range has no tools
  5. Multiple tool results for same callID
  6. Parallel tool calls (multiple callIDs in one assistant message)
  7. Gap tolerance (non-tool message between tool_use and result)
  8. Flows through to resolveSelection (messageIds and toolIds correct)
  9. Kind change from block to message on backward extension

### Verification
- typecheck: clean
- Full suite: 947 tests pass, 0 fail

### Oracle Review Fixes
- **Tier misclassification risk**: Block anchors are compress tool_use messages (have callIDs). Forward scan would flip `endReference.kind` from `"compressed-block"` to `"message"`, corrupting tier detection (T2 → T1).
- **Fix 1**: Exclude `compress` tool callIDs from scan (`part.tool === "compress" → continue`)
- **Fix 2**: Only extend MESSAGE boundaries (`startReference.kind === "message"` guard)
- **New tests**: block boundary kind preserved (b1→b1 T2 distillation), compress excluded from scan
- **Final**: typecheck clean, 949 tests pass, CI all green (5/5)
