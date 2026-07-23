# WORKLOG - Remove subagent history rewriting

- Task ID: `2026-07-22_remove-subagent-history-rewrite`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-07-22 23:50

## 1. Summary

- **What was done**: Removed `injectExtendedSubAgentResults` from the
  message-transform pipeline and `appendProtectedTools`, deleted the
  supporting `lib/subagents/subagent-results.ts` and
  `lib/messages/inject/subagent-results.ts` files, and dropped the
  `subAgentResultCache` field from `SessionState`.
- **Why**: The history-rewriting path was mutating prior `<task_result>`
  tool outputs in the parent agent on every transform run, which broke the
  provider's prefix cache. OpenCode already appends the completed result
  natively, so the rewrite was both redundant and harmful.
- **Behavior / compatibility changes**: Yes. `experimental.allowSubAgents`
  no longer triggers parent-history rewriting. It still enables ACP inside
  subagent sessions (unchanged). No persisted state format change — the
  removed cache field was never persisted.
- **Risk level**: Low.

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `<pending>` | feat: remove subagent history rewriting (fix cache stall) |

### Key Files

- `lib/hooks.ts` — removed `injectExtendedSubAgentResults` import and the
  pipeline call between `prune` and `buildPriorityMap`.
- `lib/compress/protected-content.ts` — `appendProtectedTools` no longer
  takes `allowSubAgents`; removed the subagent-session fetch + rewrite
  branch. Now uses `part.state.output` as-is.
- `lib/compress/range.ts` — updated call site.
- `lib/compress/message.ts` — updated call site.
- `lib/messages/inject/subagent-results.ts` — **deleted** (82 lines).
- `lib/subagents/subagent-results.ts` — **deleted** (74 lines);
  `lib/subagents/` directory removed.
- `lib/messages/index.ts` — dropped re-export of removed symbol.
- `lib/state/types.ts` — removed `subAgentResultCache: Map<string, string>`.
- `lib/state/state.ts` — removed cache init in `createSessionState` and
  `.clear()` in `resetSessionState`.
- `tests/phantom-block.test.ts`, `tests/strategies-purge-errors.test.ts`,
  `tests/strategies-dedup.test.ts`, `tests/compress-state.test.ts`,
  `tests/compress-search.test.ts`, `tests/acp-status.test.ts`,
  `tests/recap.test.ts`, `tests/query-mock.test.ts`,
  `tests/message-ids.test.ts`, `tests/search-context.test.ts` —
  dropped `subAgentResultCache: new Map()` from mock state.
- `tests/e2e-message-transform.test.ts` — updated pipeline comment.

## 3. Design & Implementation Notes

- **Entry point / key function**: The whole change centers on
  `injectExtendedSubAgentResults` (`lib/messages/inject/subagent-results.ts`),
  which was called from `createChatMessageTransformHandler` in `lib/hooks.ts`
  on every message-transform run.
- **Key configuration items**: `experimental.allowSubAgents` retains its
  primary meaning (gate ACP inside subagent sessions). Its secondary meaning
  (parent-history rewriting) is gone.
- **Key logic explanation**: The root cause of the cache stall was not the
  rewrite itself but the fact that the rewrite was **non-idempotent across
  turns** because `subAgentResultCache` was cleared on every parent↔child
  session switch and was never persisted. So each transform run re-fetched
  the subagent session and produced a new (content-equal but
  instance-different) historical message body, invalidating the provider
  prefix cache at that message. Removing the rewrite entirely is the clean
  fix; persisting the cache would have been a band-aid that kept a redundant
  behavior alive.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck   # tsc --noEmit — clean
npm run test        # node --import tsx --test tests/*.test.ts
```

### Test Coverage

- New/modified test files: 0 new tests; 11 existing test files updated to
  match the new `SessionState` shape (removed field from mocks).
- Test count: 835 total, 835 pass, 0 fail.
- Key scenarios verified: full transform pipeline, compress range/message
  modes, state creation/reset, all baseline + tier-1 + tier-2 + functional
  + e2e suites.

### Results

- **PASS**: typecheck clean, 835/835 tests pass.

## 5. Risk Assessment & Rollback

- **Risk points**:
  - Users who relied on the rewrite (expanded historical `<task_result>`
    visible to the model mid-session) lose that behavior. OpenCode's native
    `state="completed"` follow-up message already carries the same content,
    so the impact is theoretical.
- **Rollback method**:
  - `git revert <commit>` — no schema or state-format changes.
- **Compatibility notes**: No persisted-state format change. The removed
  `subAgentResultCache` field was never written to disk.

## 6. Follow-ups

- (none)
