# WORKLOG - Yield to billion-context native mode via action-time env re-check

- Task ID: `2026-09-16_billion-context-native-yield`
- Home Repo: `opencode-acp`
- Status: InProgress
- Updated: 2026-09-16 11:10

## 1. Summary

- **What was done**: Added action-time (lazy) detection of billion-context ownership markers (`BILLION_CONTEXT_PROXY`, `BILLION_CONTEXT_NATIVE`) at every ACP action point — setup fast path, hook guard, config hook, and the shared tool entry point — so ACP yields to billion-context in launcher AND native modes regardless of plugin load order.
- **Why**: In native mode (billion-context #820/#824) the ownership marker is written asynchronously/after ACP setup, and configured provider baseURLs never carry `/bili/`, so all pre-existing static-sampling signals missed it → double compression (#405).
- **Behavior / compatibility changes**: Yes — new yield path for a previously undetectable scenario; all existing behavior (launcher env check, `/bili/` baseURL detection, logs) preserved. No state-format or API changes.
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit      | Description                                                                    |
| ----------- | ------------------------------------------------------------------------------ |
| 278bea6     | feat: yield to billion-context native mode via action-time env re-check (#405) |
| (this rev.) | fix: address PR #406 dual-agent review findings                                |

### Key Files

- `lib/bili-proxy.ts` — new pure `detectBiliEnvYield(env?)` + `describeBiliEnvYield(source)` + `biliYieldLogMessage(source)` (single source of truth for the console announcement; keeps the launcher wording byte-identical to master) + exported env-var name constants; documents the cross-repo marker timing contract.
- `index.ts` — setup early-return now covers both markers; `guard()` re-samples env per call with one-time log per source; config hook re-samples env each run and denies all 5 ACP tools via extracted `denyAcpTools()` helper (shared with the existing `/bili/` branch).
- `lib/compress/types.ts` — `resolveToolContext()` (first statement of every ACP tool's execute) now throws a clear "disabled" error when either marker is set at action time — defense-in-depth covering all five tools at one chokepoint.
- `tests/bili-native-yield.test.ts` — new: unit tests for the pure detector + integration tests through the real factory (setup fast path ×2 markers, runtime marker → deny/no-op/tool-throws for ALL five tools, launcher parity, re-enable, one-time log).
- `tests/bili-proxy-integration.test.ts` — one line: also `delete process.env.BILLION_CONTEXT_NATIVE` in the pre-import env setup (the new setup fast path would otherwise break this suite if the host env carried the marker).

## 3. Design & Implementation Notes

- Marker contract verified against billion-context branch `2026-09-15_opencode-native-plugin`: `src/agent/native-bootstrap.ts` `markNativeHost()` sets `env.BILLION_CONTEXT_NATIVE = "opencode"` synchronously at module evaluation (before any await, first-writer-wins); called from `src/agent/opencode-native.ts:160` guarded by `nativeBootstrapGate` (which refuses to run when `BILLION_CONTEXT_PROXY` is already set — hence launcher precedence in `detectBiliEnvYield`).
- Why three sampling points: setup = cheap full bail-out when load order favors us; guard/config-hook = covers the race where the native module evaluates after ACP setup (hooks no-op + tools removed from LLM list); `resolveToolContext` = covers the residual window where a tool call lands after the last config run but before opencode re-applies permissions.
- One-time log dedup is per factory instance (closure var `announcedEnvYieldSource`) because `guard()` runs on every LLM request.
- The `/bili/` branch keeps its original log message verbatim (no hidden external dependency assumed, but no reason to churn it).

## 4. Verification

- [x] `npm run typecheck` — clean
- [x] `npm test` — 1273 pass / 0 fail (new file adds 10 tests, all green)
- [x] `npm run build` — success
- [x] Mutation check: with `index.ts` + `lib/compress/types.ts` reverted to master, 7/10 new tests FAIL; with the fix, 10/10 PASS
- [x] `format:check`: repo baseline already fails (~450 files pre-existing drift, left untouched); new files fully prettier-formatted; two targeted prettier fixes applied to tracked files per review (import line in `index.ts`, wrapped signature in `lib/bili-proxy.ts`)

## 5. Review Round (PR #406, dual-agent)

Two independent agents reviewed source + tests. Dispositions:

| Finding | Severity | Disposition |
| ------- | -------- | ----------- |
| Prettier violations introduced in tracked files (import block >100 cols, unwrapped signature) | low | Fixed — collapsed import to one line, wrapped `detectBiliEnvYield` signature |
| Env branch returned before assigning `disabledByBiliProxy` → stale-flag edge when an env marker and a `/bili/` provider appear/disappear together | low | Fixed — flag computed before either branch (invariant documented in code) |
| Launcher log wording drifted from master (hidden external dependency risk) | info | Fixed — `biliYieldLogMessage()` restores the exact master string for launcher |
| Fail-closed tradeoff not documented (marker set but billion-context bootstrap later fails → ACP stays off until restart) | info | Documented in PR body (chosen over fail-open double-compression risk) |
| Tool-gate test covered only 2 of 5 tools | test | Fixed — all five tools exercised through the shared `resolveToolContext` gate |
| Hooks-no-op test missed `command.execute.before` | test | Fixed — invocation added, asserts output parts stay empty |
| Re-enable test lacked try/finally around the env mutation (demonstrated cascade failures) | test | Fixed |
| Sibling `bili-proxy-integration.test.ts` didn't clean `BILLION_CONTEXT_NATIVE` | test | Fixed — one-line delete in pre-import setup |
| `announcedEnvYieldSource` never resets (cosmetic: re-announce if marker toggles off/on within one process lifetime) | info | Accepted — detection itself is live every call; only the announcement dedup is sticky |

Re-verified after fixes: `npm run typecheck` clean, `npm test` 1273/1273, `npm run build` OK, new test file prettier-clean.
