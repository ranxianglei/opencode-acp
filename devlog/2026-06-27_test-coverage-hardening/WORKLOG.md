# WORKLOG: Test Coverage Hardening

## 2026-06-27

### Dead Code Cleanup (Step 1)

**Audit performed:**
- Ran full test suite: 407 tests, 0 failures (AGENTS.md was stale at 350)
- Built source ↔ test coverage matrix for all 70 source files
- Dead-code analysis via explore agent (cross-validated all exports against imports)

**Changes made:**

1. **`lib/ui/notification.ts`** — Deleted `sendUnifiedNotification` (L93-137, 45 LOC).
   Never called anywhere in codebase. Also deleted cascade-dead `truncateExtractedSection`
   (L77-91, 15 LOC) which was only called by sendUnifiedNotification.

2. **`lib/ui/utils.ts`** — Deleted `formatPruningResultForTool` (L289-304, 16 LOC).
   Never called anywhere.

3. **`lib/state/state.ts`** — Removed 3 commented-out `logger.info` debug lines (L150-151, L159).

4. **Unexported 6 internal-only symbols:**
   - `appendToToolPart` (messages/utils.ts) — only called by appendToAllToolParts
   - `truncate` (ui/utils.ts) — only called by formatPrunedItemsList
   - `shortenPath` (ui/utils.ts) — only called by formatPrunedItemsList
   - `MESSAGE_REF_MAX_INDEX` (message-ids.ts) — only used in formatMessageRef/parseMessageRef
   - `getConfigKeyPaths` (config-validation.ts) — only called by validateConfigTypes
   - `checkAutoUpdate` (update.ts) — only called by startAutoUpdate

5. **`AGENTS.md`** — Updated test count 350 → 407, file count 22 → 31.

**Verification:**
- typecheck: pass
- tests: 407 pass, 0 fail
- No runtime behavior changes (only removed dead code + reduced exports)

### Tier 1 Test Coverage (Step 2)

**Goal:** Establish behavioral test coverage for the 8 critical untested modules to serve as spec for clean-room rewrite.

**New test files (7 files, 66 new tests):**

| File | Tests | Module |
|------|-------|--------|
| tests/prune.test.ts | 16 | messages/prune.ts — filterCompressedRanges, pruneToolOutputs, pruneToolInputs, pruneToolErrors |
| tests/reasoning-strip.test.ts | 7 | messages/reasoning-strip.ts — stripStaleMetadata |
| tests/sync.test.ts | 8 | messages/sync.ts — syncCompressionBlocks |
| tests/protected-content.test.ts | 14 | compress/protected-content.ts — extractProtectedPromptInfo, appendProtectedUserMessages, appendProtectedPromptInfo |
| tests/persistence.test.ts | 7 | state/persistence.ts — saveSessionState, loadSessionState |
| tests/inject.test.ts | 9 | messages/inject/inject.ts — injectMessageIds, injectCompressNudges |
| tests/pipeline.test.ts | 5 | compress/pipeline.ts — prepareSession, finalizeSession |

**Modules NOT tested:** config.ts merge logic (8th Tier 1 module) — filesystem-dependent, reads from 3 config layers. Config *validation* already covered by config-validation.test.ts.

**Verification:**
- typecheck: pass (exit 0)
- tests: 473 pass, 0 fail (was 407)
- Dual-agent review: both APPROVED

**Branch rebase:**
- Feature branch rebased onto GitHub master `6bd554b` (was based on stale local master `f0315a6`)
- Resolved merge conflict caused by README commits diverging between local and GitHub
- Force-pushed to both gitea and GitHub as `a8c2d40`
