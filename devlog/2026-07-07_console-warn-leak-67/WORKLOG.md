# WORKLOG - Route range-utils placeholder diagnostic to logger

- Task ID: `2026-07-07_console-warn-leak-67`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-07-07 21:40

## 1. Summary

- **What was done**: Replaced the `console.warn(...)` call in `validateSummaryPlaceholders` (Plan B placeholder-omission path) with `logger.warn(...)`, and threaded a `logger: Logger` parameter through the function signature and its single caller in `range.ts`. Updated the 3 call sites in the test file.
- **Why**: opencode's TUI captures plugin stderr and renders it into the chat dialog the model reads; the `console.warn` diagnostic leaked mid-turn on every compress that omitted `(bN)` placeholders. The `Logger` writes only to disk and is debug-gated, so the diagnostic never reaches the dialog.
- **Behavior / compatibility changes**: No. Internal function signature change only; no persisted-state, config, or public-API surface touched.
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit  | Description                                                   |
| ------- | ------------------------------------------------------------- |
| `<sha>` | fix: route range-utils placeholder diagnostic to logger (#67) |

### Key Files

- `lib/compress/range-utils.ts` — imported `Logger`; added `logger: Logger` 7th param to `validateSummaryPlaceholders`; `console.warn` → `logger.warn`; dropped `[ACP]` prefix.
- `lib/compress/range.ts` — call site at line ~137 now passes `ctx.logger`.
- `tests/compress-range-placeholders.test.ts` — added module-level `const logger = new Logger(false)`; passed `logger` to all 3 `validateSummaryPlaceholders` call sites.

## 3. Design & Implementation Notes

- **Entry point / key function**: `validateSummaryPlaceholders(...)` in `lib/compress/range-utils.ts`.
- **Key configuration items**: None — `Logger` is constructed with `enabled = config.debug` (default `false`).
- **Key logic explanation**: The `Logger` class early-returns from every method when `enabled === false`, so routing the diagnostic there silences it in production while preserving it in debug logs. This is semantically correct: the diagnostic is internal developer noise, not user-facing information.

### Audit of remaining `console.*` sites (kept as-is, documented)

| Site                                             | Decision                          | Reason                                                                                                                                                                                                                        |
| ------------------------------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts` (4 sites, dcp→acp migration notices) | Kept `console.log`                | Runs at plugin init before `Logger` exists (`getConfig` at `index.ts:29` → `new Logger` at `index.ts:35`). Logger is debug-gated; routing user-facing one-time migration notices through it would silence them in production. |
| `prompts/store.ts:186/188` (prompt migration)    | Kept `console.log`/`console.warn` | Same debug-gating concern; `resolvePromptPaths` is a free function; one-time user-facing migration events should stay visible regardless of the debug flag.                                                                   |

## 4. Testing & Verification

### Build & Test Commands

```sh
# Type check
npm run typecheck

# Full test suite
bun test

# Build
npm run build
```

### Test Coverage

- New/modified test files: `tests/compress-range-placeholders.test.ts`
- Test count: 563 total pass, 1 fail (pre-existing `prompts.test.ts` bun incompatibility — `test() inside test()`, unrelated to this change)
- Key scenarios verified: `validateSummaryPlaceholders` correctly accepts the new logger param; all 6 placeholder tests pass.

### Results

- **PASS** (typecheck clean, build success, bundle verified: `omitted placeholders for required blocks` now via `logger.warn`; only remaining `console.warn` in bundle is the intentional `prompts/store.ts` migration notice).

## 5. Risk Assessment & Rollback

- **Risk points**: None beyond the function signature change, which is internal-only.
- **Rollback method**: Revert the commit.
- **Compatibility notes**: No persisted-state, config, or public-API changes.

## 6. Lessons Learned (optional)

- `Logger` is a debug-only sink (early-returns when `enabled === false`). This makes it correct for internal diagnostics but **wrong** for user-facing one-time notices (migration success/failure), which must remain visible regardless of the debug flag. The two cases warrant different handling — a blanket "convert all console.\* to logger" would hide legitimate user notices.

## 7. Follow-ups (optional)

- [ ] Consider adding a non-debug, always-visible notice channel for future user-facing plugin events if `console.*` proves problematic at startup.
