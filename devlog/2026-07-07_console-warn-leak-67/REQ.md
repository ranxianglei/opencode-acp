# REQ - Route range-utils placeholder diagnostic to logger

- Task ID: `2026-07-07_console-warn-leak-67`
- Home Repo: `opencode-acp`
- Created: 2026-07-07
- Status: Done
- Priority: P1
- Owner: awork
- References: GitHub issue #67

## 1. Background & Problem Statement

- **Context**: `validateSummaryPlaceholders()` in `lib/compress/range-utils.ts` emits a Plan B diagnostic when the model omits `(bN)` block placeholders in its compress summary.
- **Current behavior (symptom)**: The diagnostic used `console.warn(...)`, which writes to stderr. opencode's TUI captures plugin stdout/stderr and renders it into the chat dialog the model reads. This leaked `[ACP] compress summary omitted placeholders...` into the conversation mid-turn whenever the model omitted placeholders — the same dialog-pollution class as the historical sentinel-throw / `output.parts` leaks.
- **Expected behavior**: The diagnostic is routed to the plugin's `Logger` (debug sink writing to `~/.config/opencode/logs/acp/`) so it never reaches the chat dialog, while remaining available for debugging.
- **Impact**: Every compress call where the model omits `(bN)` placeholders polluted the model's context. Noise grows with compression frequency.

## 2. Reproduction (if applicable)

- **Environment**: opencode with opencode-acp plugin active; default config (range mode).
- **Minimal reproduction steps**:
  1. Trigger a `compress` call whose summary omits a `(bN)` placeholder for a consumed block.
  2. Observe `[ACP] compress summary omitted placeholders for required blocks: bN...` rendered in the chat dialog.
- **Relevant configuration**: N/A (default config reproduces).

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: `validateSummaryPlaceholders` is an internal function (not exported from the package public API); signature change is safe.
  - The `Logger` is debug-gated (`enabled = config.debug`, default `false`) and writes only to disk — it never touches stdout/stderr.
- **Non-Goals** (explicitly out of scope):
  - Converting `console.*` in `lib/config.ts` and `lib/prompts/store.ts`. These are user-facing one-time migration notices that run before `Logger` exists (config init) and/or must stay visible regardless of the debug flag. See audit rationale in the PR description.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] `validateSummaryPlaceholders` calls `logger.warn(...)` instead of `console.warn(...)`.
  - [x] The caller in `lib/compress/range.ts` passes `ctx.logger`.
  - [x] No `[ACP]` prefix in the message (Logger manages component tagging via `getCallerFile`).
- **Performance / Stability**:
  - [x] No new disk I/O when `debug === false` (Logger early-returns).
- **Regression**:
  - [x] New/modified test cases added to test suite and passing (3 call sites in `tests/compress-range-placeholders.test.ts` updated).

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
  - `lib/compress/range-utils.ts` — add `logger: Logger` param, route to `logger.warn`.
  - `lib/compress/range.ts` — pass `ctx.logger` at the call site.
  - `tests/compress-range-placeholders.test.ts` — construct `new Logger(false)` and thread through 3 call sites.
- **Risks**: Low. Purely an internal diagnostic-routing change.
- **Rollback strategy**: Revert the commit.
