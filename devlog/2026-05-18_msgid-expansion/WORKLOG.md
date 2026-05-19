# WORKLOG - Message Ref Format Expansion

- Task ID: `2026-05-18_msgid-expansion`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-05-19

## 1. Summary

- **What was done**: Expanded message ref format from 4-digit (`mNNNN`, max 9999) to 5-digit (`mNNNNN`, max 99999). Added backward compat migration for old persisted state. Fixed critical bug where 4-digit keys in `byRef` map weren't normalized.
- **Why**: Sessions exceeding 10,000 messages would produce duplicate refs causing compress failures. ACP targets 10,000+ message sessions.
- **Behavior / compatibility changes**: Yes — message refs now use 5-digit format. Old state auto-migrates on load.
- **Risk level**: Medium — persisted state migration must handle mixed formats

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `c1e5807` | feat: expand message ref format from 4-digit to 5-digit (9999→99999) |
| `16355dd` | fix: backward compat migration for 4-digit→5-digit refs + mNNNNN updates |
| `5e54496` | fix: remove duplicate keys in message-utils.ts ISSUE_TEMPLATES |
| `e1a9a31` | docs: add dual-agent review requirement for code + tests, PR workflow |

### Key Files

- `lib/message-ids.ts` — Ref format changed from `%04d` to `%05d`, regex patterns updated to match 5-digit refs
- `lib/compress/state.ts` — `ensureSessionInitialized` now migrates old 4-digit `byRef` keys to 5-digit
- `lib/compress/message-utils.ts` — Removed duplicate keys in ISSUE_TEMPLATES
- `lib/state/state.ts` — State loading normalizes ref format
- `AGENTS.md` — Updated with dual-agent review requirement

## 3. Design & Implementation Notes

- **Entry point / key function**: `ensureSessionInitialized()` in `state.ts` handles migration when loading persisted state
- **Key configuration items**: Ref format `%05d` (5-digit zero-padded)
- **Key logic explanation**: Migration iterates `byRef` map, identifies 4-digit keys matching pattern `m\d{4}`, and re-inserts with 5-digit format. This runs on every state load, making it idempotent.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run build        # Passes
npm run typecheck    # Passes
npm run test         # 350 tests, 0 failures
```

### Test Coverage

- No new test files in this iteration (existing message-ids.test.ts covers ref format)
- Test count: 350 total, 350 pass, 0 fail (7 new tests from prior iteration's E2E additions)
- Key scenarios verified: ref generation, boundary resolution, state persistence

### Results

- **PASS**: All 350 tests pass, CI green on Node 22/24
- **Critical bug found in review**: 4-digit keys in `byRef` map not normalized — fixed in `16355dd`
- **Review**: Dual-agent review performed, one critical issue found and fixed

## 5. Risk Assessment & Rollback

- **Risk points**: Mixed 4/5 digit refs in persisted state could cause boundary resolution failures
- **Rollback method**: Revert commits `c1e5807` through `5e54496`
- **Compatibility notes**: Migration is one-way (4→5 digit). Downgrading after migration will break ref lookups.

## 6. Lessons Learned

- What went well: Dual-agent review caught the `byRef` normalization bug that self-review missed
- What could be improved: Should have tested migration with actual persisted state from a real session
- Reusable conclusions: Format changes in persisted data always need migration logic, not just format updates. The `byRef` map is a particularly tricky case because keys and values both contain refs.
