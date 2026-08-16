# REQ - Write ERROR/WARN logs by default (without debug: true)

- Task ID: `2026-08-16_default-error-logging`
- Home Repo: `opencode-acp`
- Created: 2026-08-16
- Status: Done
- Priority: P1
- Owner: ranxianglei
- References: user report — "用户说任务报错 我应该让他找什么日志"

## 1. Background & Problem Statement

- **Context**: `Logger` is constructed as `new Logger(config.debug)` (index.ts:35). With the default `debug: false`, `write()`, `saveContext()` and the level methods all early-return, so **no log file is created at all** under `~/.config/opencode/logs/acp`. When a user's task errors out, there is nothing on disk to diagnose from.
- **Current behavior (symptom)**: with default config, `~/.config/opencode/logs/acp` never exists; ERROR/WARN events ("Failed to load session state", "Failed to send notification", quality-gate failures, provider 400 related warnings) are silently discarded.
- **Expected behavior**: with default config, ERROR and WARN events are still appended to `~/.config/opencode/logs/acp/daily/<date>.log`; INFO/DEBUG and per-request context snapshots (`context/<sessionId>/*.json`) remain gated behind `debug: true`.
- **Impact**: users can now diagnose task failures from the daily log without enabling full debug (which also enables the heavy per-request context snapshots).

## 2. Reproduction (if applicable)

- **Environment**:
  - Node: 22/24 (CI matrix)
  - OS/Arch: linux-x64
- **Minimal reproduction steps**:
  1) Run opencode with default `acp.jsonc` (no `debug` key → default `false`, lib/config.ts:176)
  2) Trigger an ACP error path (e.g. corrupt `~/.local/share/opencode/storage/plugin/acp/<sessionId>.json` → "Failed to load session state")
  3) Observe `~/.config/opencode/logs/acp` does not exist — no evidence on disk
- **Relevant configuration**:
  ```jsonc
  // ~/.config/opencode/acp.jsonc
  { "debug": false } // default
  ```

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: no persisted-state or config-schema changes; only the logging gate changes. `debug: true` behavior is unchanged (all levels + context snapshots).
  - Performance: daily-log append is a single small `writeFile` with `flag: "a"` — cost is negligible; WARN/ERROR call sites are all rare anomaly events (state load failures, notification failures, quality-gate failures, phantom batch entries), so default volume stays tiny.
- **Non-Goals** (explicitly out of scope):
  - Promoting high-frequency DEBUG call sites (nudge injection, filter decisions, compression-start recording) to always-written INFO — that would bloat the daily log. They stay `debug`-gated.
  - Writing per-request context snapshots by default (heavy; remains `debug`-gated).
  - Adding new call sites for upstream (provider) API errors — opencode core owns those; this PR only changes the gate so existing ERROR/WARN sites become visible by default.
  - Changing the version field in package.json (forbidden on non-release branches).

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [ ] With `debug: false`: `logger.error(...)` and `logger.warn(...)` append a line to `~/.config/opencode/logs/acp/daily/<YYYY-MM-DD>.log`
  - [ ] With `debug: false`: `logger.info(...)` and `logger.debug(...)` do NOT write
  - [ ] With `debug: true`: all four levels write (unchanged behavior)
- **Performance / Stability**:
  - [ ] Log line format unchanged: `<ISO timestamp> <LEVEL> <component>: <message> | <data> | v=<version>`
- **Regression**:
  - [ ] New test file `tests/logger.test.ts` added and passing; full suite `npm run test` green; `npm run typecheck` and `npm run build` pass

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
  - `lib/logger.ts` — move the enable gate into `write()` per level: gate becomes `if (!this.enabled && level !== "ERROR" && level !== "WARN") return`; drop the `enabled` early-return inside `warn()` and `error()` so they always flow to `write()`; keep it in `info()` and `debug()`.
  - `tests/logger.test.ts` (new) — construct `Logger(false)` / `Logger(true)`, point `XDG_CONFIG_HOME` at a temp dir, await each level, assert daily-log file contents.
- **Risks**:
  - WARN volume: all WARN sites are anomaly paths; worst case a few lines per session — acceptable.
  - `write()` silently swallows FS errors (existing `catch (error) {}`) — behavior unchanged.
- **Rollback strategy**:
  - Revert the single logger.ts hunk; no state or API changes to unwind.
