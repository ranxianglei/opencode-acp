# WORKLOG: Fork Session Compression State Rebuild

## 2026-07-09

### Diagnosis
- Confirmed bug: fork session `ses_0b9ccf1c8ffeX6k30Cjznzd5Bq` overflows because ACP state
  file `{sessionId}.json` doesn't exist for fork, and all internal maps key off raw
  message IDs that OpenCode regenerates on fork.
- Root cause: `ensureSessionInitialized` (`state.ts:169-172`) early-returns when
  `persisted === null`, leaving prune state empty → `filterCompressedRanges`
  (`prune.ts:214-219`) early-returns → no pruning → all messages sent verbatim.

### Implementation
- Created `lib/state/rebuild.ts`: replays completed `compress` tool parts from message
  history to reconstruct `CompressionBlock` / `byMessageId` / `activeByAnchorMessageId`.
- Key insight: message refs (`mNNNNN`) are position-based (`assignMessageRefs` assigns
  sequentially by order), so they're fork-stable — compress input `startId`/`endId`
  resolve to the same logical messages in fork.
- Wired into `ensureSessionInitialized` via optional `config` param. All production
  callers (hooks.ts, pipeline.ts, decompress.ts) pass config; tests unaffected.
- Reuses existing pipeline functions (`resolveRanges`, `resolveSelection`,
  `applyCompressionState`, `filterProtectedToolMessages`) for structural correctness.

### Testing
- 9 unit tests in `tests/rebuild.test.ts`:
  - No compress parts → no-op
  - Single range compression → block + byMessageId populated
  - Fork scenario (different raw IDs, same refs) → correct mapping
  - Nested compression (b1 consumed by b2) → b1 deactivated, b2 active
  - Message-mode compression → blocks with shared runId
  - Protected tool exclusion (Bug 39 parity)
  - Malformed input → graceful skip
  - Non-completed compress part → skipped
  - Idempotent ref assignment
- Full suite: 603 pass, 1 pre-existing fail (Bun nested `t.test()` limitation in
  `prompts.test.ts`, unrelated to this change).

### Verification
- `npm run build` — clean (includes `tsc --emitDeclarationOnly`)
- `bun test tests/` — 603/604 pass
- TypeScript typecheck — clean
