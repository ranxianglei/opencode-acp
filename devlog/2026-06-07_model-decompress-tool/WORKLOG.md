# WORKLOG - Model-Exposed Decompress Tool

- Task ID: `2026-06-07_model-decompress-tool`
- Home Repo: `opencode-acp`
- Status: InProgress
- Updated: 2026-06-07 22:30

## 1. Summary

- **What was done**: Exposed `decompress` as a model-accessible tool alongside the existing `/acp decompress` command. Extracted shared logic from the command into `lib/compress/decompress-logic.ts` and created a new `lib/compress/decompress.ts` tool with decompress-specific prepare/finalize pipeline.
- **Why**: The model had asymmetric context management — it could compress but not decompress. When compressed details were needed, only human users could restore via `/acp decompress`. Now the model can autonomously restore compressed content.
- **Behavior / compatibility changes**: Yes — system prompt text changed ("ONLY tool" → "tools... are"), default `protectedTools` arrays gained `decompress`. Existing configs that override `protectedTools` won't auto-include `decompress`.
- **Risk level**: Medium — context inflation from decompress, GC interaction with reactivated blocks

## 2. Change Log

### Commits

| Commit    | Description                              |
| --------- | ---------------------------------------- |
| (pending) | feat: expose decompress tool to AI model |

### Key Files

- `lib/compress/decompress-logic.ts` — NEW: Shared decompress logic extracted from command (parseBlockIdArg, deactivateCompressionTarget, computeRestoredMessages, buildRestoredContentPreview)
- `lib/compress/decompress.ts` — NEW: Decompress tool with decompress-specific prepare/finalize, inline content preview
- `lib/compress/index.ts` — MODIFIED: Export createDecompressTool
- `lib/commands/decompress.ts` — MODIFIED: Refactored to use shared logic from decompress-logic.ts
- `index.ts` — MODIFIED: Register decompress tool + add to primary_tools
- `lib/prompts/system.ts` — MODIFIED: Base prompt updated to mention both tools
- `lib/prompts/extensions/system.ts` — MODIFIED: Added DECOMPRESS_SYSTEM_EXTENSION
- `lib/prompts/store.ts` — MODIFIED: Added decompressExtension to RuntimePrompts
- `lib/prompts/index.ts` — MODIFIED: renderSystemPrompt accepts decompress flag
- `lib/hooks.ts` — MODIFIED: Pass decompress=true when permission allows
- `lib/config.ts` — MODIFIED: Added "decompress" to DEFAULT_PROTECTED_TOOLS and COMPRESS_DEFAULT_PROTECTED_TOOLS
- `tests/decompress-logic.test.ts` — NEW: Tests for shared decompress logic

## 3. Design & Implementation Notes

- **Entry point / key function**: `createDecompressTool()` in `lib/compress/decompress.ts`
- **Key configuration items**: Reuses `compress.permission` for both tools
- **Key logic explanation**:
    - Decompress-specific `prepareDecompressSession()` — NO dedup/purge, NO manual mode guard (decompress always allowed)
    - Decompress-specific `finalizeDecompressSession()` — just saves state, NO compress notification
    - Tool returns inline restored content preview (~2000 chars) so model can reason immediately without waiting for next turn
    - Context usage before/after included in return value for model self-regulation
    - Shared logic extracted to `decompress-logic.ts` — both command and tool use identical functions

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run build
npm run typecheck
node --import tsx --test tests/*.test.ts
```

### Test Coverage

- New test files: `tests/decompress-logic.test.ts`
- Test count: 350 baseline + new tests
- Key scenarios verified: parseBlockIdArg, deactivateCompressionTarget, computeRestoredMessages, buildRestoredContentPreview, computeReactivatedBlockIds, findActiveParentBlockId

### Results

- **PASS**: typecheck clean, build success, all 350 baseline tests pass

## 5. Risk Assessment & Rollback

- **Risk points**: Context inflation from decompress, GC may truncate reactivated nested blocks sooner, model misuse (decompress without recompress)
- **Rollback method**: Revert commit, remove decompress tool registration
- **Compatibility notes**: System prompt text change may require prompt override update for users with custom prompts

## 7. Follow-ups

- [ ] Consider exposing recompress as model tool
- [ ] Consider resetting survivedCount on reactivated nested blocks
- [ ] Consider making inline content preview length configurable
