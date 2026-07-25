# WORKLOG — preserve-first-user

## Changes

### lib/messages/prune.ts

Replaced the 16-line `preserve-last-user` loop (lines 209-224) with a 4-line
`preserve-first-user` block:

```typescript
const firstUserIdx = messages.findIndex((msg) => msg.info.role === "user")
if (firstUserIdx >= 0) {
    survive[firstUserIdx] = true
}
```

The previous implementation depended on the most recent pruned user message
still being in the `messages` array. After OpenCode compaction removes pruned
messages, there was nothing to restore, and zero-user requests hit the provider.

### tests/prune.test.ts

Rewrote the 5 tests under the `preserve-last-user` section:

1. "always preserve first user msg even when it falls in a compressed range" —
   first user survives, later pruned users stay pruned
2. "always preserve first user even when a newer uncompressed user survives" —
   both first (force-preserved) and newer (uncompressed) survive
3. "preserve first user when multiple user msgs are all compressed" — only the
   first survives, middle/newest stay pruned
4. "no restoration when input has zero user messages at all" — unchanged, still
   valid (`findIndex` returns -1, guard skips)
5. "preserved first user msg keeps its original parts intact" — asserts first
   user content is byte-identical

## Verification

- `npm run typecheck` — clean
- `npm test` — **846 pass, 0 fail**
- `npm run build` — clean

## Tests modified

### tests/prune.test.ts (5 tests rewritten)
All under the renamed `preserve-first-user` section. Tests 1, 3, 5 assert the
first user is force-preserved. Test 2 asserts both first user (force-preserved)
and newer uncompressed user survive. Test 4 (zero user msgs) unchanged.

### tests/e2e-message-transform.test.ts (3 tests updated)
- "message IDs remain consistent": u1 now survives (force-preserved)
- "Bug 36 — no adjacent users": updated to accept u1+u2 adjacency as an accepted
  trade-off (the `isForcePreservedFirstUser` exception). The no-adjacent-users
  invariant still holds for all non-first-user pairs.
- "compressed messages are replaced with summaries": u1 now survives

## Trade-off: API validity vs no-adjacent-users

preserve-first-user can produce two adjacent user messages when the first user
is compressed and a later user also survives (e.g., `[u1, u2, a2]`). This is an
accepted trade-off:

- **Zero user messages** → hard API rejection (zhipuai-lb code 1214, session
  freezes). MUST prevent.
- **Adjacent user messages** → accepted by virtually all providers (OpenAI,
  Anthropic, Google, zhipuai-lb). Soft concern at most.

The Bug 36 test was updated to reflect this: the no-adjacent-users invariant
still holds for all non-first-user pairs, but the force-preserved first user
is exempted.
