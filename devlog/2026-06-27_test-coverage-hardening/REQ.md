# REQ: Test Coverage Hardening for Clean-Room Migration

## Background

ACP is forked from DCP under AGPL-3.0. To relicense to MIT, we need a clean-room
reimplementation. The existing 407 tests + AGENTS.md data flow + devlog REQs serve
as the natural behavior spec.

Before migration, we must harden the test foundation: remove dead code, close
coverage gaps on critical modules, and ensure every core behavior is captured by tests.

## Phase 1: Dead Code Cleanup (this iteration)

### Goals

1. Remove genuinely dead functions never called anywhere
2. Clean commented-out debug logs
3. Unexport symbols only used internally (reduce public API surface)
4. Update stale AGENTS.md test count (350 → 407)

### Scope

| Change                              | File                       | Details                                    |
| ----------------------------------- | -------------------------- | ------------------------------------------ |
| Delete `sendUnifiedNotification`    | `lib/ui/notification.ts`   | 45-line function, never called             |
| Delete `truncateExtractedSection`   | `lib/ui/notification.ts`   | 15-line function, cascade-dead after above |
| Delete `formatPruningResultForTool` | `lib/ui/utils.ts`          | 16-line function, never called             |
| Remove commented logs               | `lib/state/state.ts`       | 3 lines of `// logger.info(...)`           |
| Unexport `appendToToolPart`         | `lib/messages/utils.ts`    | Only used internally                       |
| Unexport `truncate`                 | `lib/ui/utils.ts`          | Only used internally                       |
| Unexport `shortenPath`              | `lib/ui/utils.ts`          | Only used internally                       |
| Unexport `MESSAGE_REF_MAX_INDEX`    | `lib/message-ids.ts`       | Only used internally                       |
| Unexport `getConfigKeyPaths`        | `lib/config-validation.ts` | Only used internally                       |
| Unexport `checkAutoUpdate`          | `lib/update.ts`            | Only used internally                       |

### Acceptance Criteria

- [x] All dead functions removed
- [x] All unnecessary exports unexported
- [x] Commented-out debug logs cleaned
- [x] AGENTS.md test count updated
- [x] `npm run typecheck` passes
- [x] All 407 tests pass
- [x] Dual-agent review completed

## Phase 2 (planned): Tier 1 Test Coverage

Add dedicated tests for 8 critical untested modules (~1,956 LOC):

- `messages/prune.ts`, `state/persistence.ts`, `messages/inject/inject.ts`
- `config.ts` (merge/migration), `compress/protected-content.ts`
- `messages/sync.ts`, `compress/pipeline.ts`, `messages/reasoning-strip.ts`
