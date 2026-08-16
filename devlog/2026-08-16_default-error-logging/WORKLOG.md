# WORKLOG - Write ERROR/WARN logs by default (without debug: true)

- Task ID: `2026-08-16_default-error-logging`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-08-16 04:30

## 1. Summary

- **What was done** (1–3 sentences): Changed `Logger` so that ERROR and WARN lines are appended to the daily log even when `debug` is off; INFO/DEBUG and per-request context snapshots remain gated behind `debug: true`.
- **Why** (1–3 sentences): With the default `debug: false`, no ACP log file was ever created, leaving users with zero on-disk evidence when a task errors. Making only the rare ERROR/WARN anomaly events write by default gives a minimal but useful diagnostic trail without the volume of full debug mode.
- **Behavior / compatibility changes**: Yes — new behavior: `~/.config/opencode/logs/acp/daily/<date>.log` now receives ERROR/WARN lines by default. No persisted-state, config-schema, or exported-API changes.
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `2ccbf25` | fix: write ERROR/WARN to daily log even when debug is off |

### Key Files

- `lib/logger.ts` — `write()` gate changed from `if (!this.enabled) return` to a level-aware gate (`if (!this.enabled && level !== "ERROR" && level !== "WARN") return`); `warn()`/`error()` no longer early-return when disabled.
- `tests/logger.test.ts` — new test file covering disabled/enabled logger across all four levels (4 tests).

## 3. Design & Implementation Notes

- **Entry point / key function**: `Logger.write()` (lib/logger.ts:75) is the single write path; gating happens there per level.
- **Key configuration items**: `debug` (lib/config.ts:176 default `false`) still gates INFO/DEBUG + context snapshots; no new config key added.
- **Key logic explanation** (if non-trivial): `write(level, ...)` now returns early only when disabled AND level is neither ERROR nor WARN. `info()`/`debug()` keep their own early-return; `warn()`/`error()` dropped theirs so they always reach `write()`.

## 4. Testing & Verification

### Build & Test Commands

```sh
# Type check
npx tsc --noEmit

# Build
cd opencode-acp && npm run build

# Run full test suite
node --import tsx --test tests/*.test.ts

# Run specific test file
node --import tsx --test tests/logger.test.ts
```

### Test Coverage

- New/modified test files: `tests/logger.test.ts` (new, 4 tests)
- Test count: 980 total, 980 pass, 0 fail (full suite, ~25.3s)
- Key scenarios verified:
  - disabled logger: ERROR + WARN lines appended to daily log; INFO/DEBUG not written; log file absent before first error/warn
  - enabled logger: all four levels write
  - line format: `<ISO ts> <LEVEL> <component>: <msg> | <data> | v=<version>`

### Results

- **PASS/FAIL**: PASS — `npx tsc --noEmit` clean; `npm run build` OK (dist/index.js 391.32 KB); full suite 980/980
- **Key logs/data**: `node --import tsx --test tests/logger.test.ts` → 4 pass; full suite → 980 pass, 0 fail

## 5. Risk Assessment & Rollback

- **Risk points**: WARN call sites are all anomaly paths (state load/save failures, notification failures, quality-gate failures, phantom batch entries) — default daily-log volume stays tiny. `write()` still swallows FS errors silently (pre-existing `catch {}`, unchanged).
- **Rollback method**:
  - Revert commit(s): `2ccbf25`
  - Rollback impact: none — no state or schema changes to unwind.
- **Compatibility notes** (data format, config schema): No

## 6. Lessons Learned (optional)

- What went well: single-gate design in `write()` keeps the decision in one place; tests isolate the log dir via `XDG_CONFIG_HOME`.
- What could be improved: component attribution in tests is environment-dependent (runner frames) — assertions match structure, not exact component names.
- Reusable conclusions: level-based gating is cheaper and safer than promoting debug sites to info; keep high-frequency DEBUG sites gated.

## 7. Follow-ups (optional)

- [ ] Consider an opt-out config key (e.g. `logs: { minimal: true }`) if WARN volume ever becomes an issue
