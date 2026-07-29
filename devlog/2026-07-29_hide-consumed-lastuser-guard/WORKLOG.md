# WORKLOG: Remove lastUserIdx guard from hideConsumedCompressCalls

## Timeline

1. **Bug report**: User reported T2 compression makes context larger, not smaller. "原来的压缩消息还在" — old compression messages still visible.
2. **Investigation**: Traced `hideConsumedCompressCalls` logic. Confirmed SDK types (ToolPart has input+output in same part, compressMessageId always set via toolCtx.messageID).
3. **Root cause found**: `lastUserIdx` guard at line 43 breaks loop at last user message. In same-turn T1+T2, T1 compress call is after lastUserIdx → never processed.
4. **Fix applied**: Removed lastUserIdx guard. Removed unused `isIgnoredUserMessage` import.
5. **Tests written**: 4 tests covering previous-turn, same-turn, active-block, and mixed-parts scenarios.
6. **Verification**: Test fails without fix (hidden=0, expected 1). All 887 tests pass with fix. Typecheck clean.

## Files Changed

- `lib/compress/hide-consumed.ts`: Removed lines 37-39 (lastUserIdx calculation) and line 43 (guard). Removed `isIgnoredUserMessage` import.
- `tests/hide-consumed.test.ts`: New file, 4 tests.
