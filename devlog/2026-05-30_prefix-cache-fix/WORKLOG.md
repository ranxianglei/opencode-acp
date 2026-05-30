# WORKLOG - Fix dynamic nudges breaking OpenAI Responses prefix cache

- Task ID: `2026-05-30_prefix-cache-fix`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-05-30 19:30

## 1. Summary

- **What was done**: Moved all dynamic ACP metadata injection (context usage, visible IDs, block guidance, anchored nudges) from historical user messages to a new synthetic suffix message at the end of the message list. Added `isSyntheticMessage()` to make synthetic messages invisible to query functions like `getLastUserMessage` and `findLastNonIgnoredMessage`.
- **Why**: ACP was modifying early user messages every turn, invalidating OpenAI Responses prefix cache for all subsequent content. Cache would plateau at ~25.6K tokens while total prompt grew to 83K+.
- **Behavior / compatibility changes**: No. Internal behavior change only — no config, state, or API changes. The same information is still injected, just at a different position.
- **Risk level**: Low

## 2. Change Log

### Key Files

- `lib/messages/inject/inject.ts` — Added `createSuffixMessage()`, changed `injectContextUsage`, `injectVisibleIdRange`, and block guidance to write to suffix message instead of last user message
- `lib/messages/inject/utils.ts` — Added `suffixMessage` parameter to `applyAnchoredNudges()`, added `isSyntheticMessage` skip in `findLastNonIgnoredMessage()`
- `lib/messages/query.ts` — Added `isSyntheticMessage()` export, updated `getLastUserMessage()` to skip synthetic messages
- `tests/e2e-blocks-nudges.test.ts` — Updated 3 tests for new suffix message behavior
- `tests/e2e-message-transform.test.ts` — Updated 3 tests for new message counts

## 3. Design & Implementation Notes

- **Entry point**: `createSuffixMessage()` in `inject.ts` creates a synthetic user message with a stable seed (`"acp-dynamic-guidance"`), ensuring deterministic IDs that won't be assigned new mNNNNN refs
- **Prefix cache preservation**: All dynamic content goes to the suffix message at the END of the array, so historical messages remain byte-stable across turns
- **Invisibility**: `isSyntheticMessage()` checks for `msg_dcp_summary_` / `msg_dcp_text_` ID prefixes, consistent with `assignMessageRefs` which already skips these

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck  # PASS
npm run build      # PASS
npm run test       # 350 tests, 350 pass, 0 fail
```

### Test Coverage

- Modified test files: `tests/e2e-blocks-nudges.test.ts`, `tests/e2e-message-transform.test.ts`
- Test count: 350 total, 350 pass, 0 fail
- Key scenarios verified:
  - Context usage injected into suffix message (not last user message)
  - Visible ID range injected into suffix message
  - Message counts include suffix message
  - `stripStaleMetadata` works correctly with suffix message present
  - Synthetic messages are invisible to `getLastUserMessage` and `findLastNonIgnoredMessage`

## 5. Risk Assessment & Rollback

- **Risk points**: Low — change is localized to injection targets, all 350 tests pass
- **Rollback method**: Revert all changes on this branch
- **Compatibility notes**: No data format or config changes

## 6. Follow-ups (optional)

- [ ] Monitor prefix cache hit rates in production with OpenAI Responses models
- [ ] Consider gating suffix message creation behind a config option if any edge cases emerge
