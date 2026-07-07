# REQ - Add spacing around arrow in context transition notification

- Task ID: `2026-07-07_arrow-spacing-68`
- Home Repo: `opencode-acp`
- Created: 2026-07-07
- Status: Done
- Priority: P2
- Owner: awork
- References: GitHub issue #68

## 1. Background & Problem Statement

- **Context**: `formatContextTransition()` in `lib/ui/notification.ts` renders the token delta shown in compression notifications (e.g. the toast/chat message after a compress completes).
- **Current behavior (symptom)**: The output was `Context 141.9K→111K` — the `→` (U+2192) had no surrounding whitespace, fusing visually with adjacent digits.
- **Expected behavior**: `Context 141.9K → 111K` — spaces around the arrow, matching the `→ ` (arrow followed by space) convention used everywhere else in the notification module.
- **Impact**: Cosmetic readability friction on every compression notification (high-frequency event).

## 2. Reproduction (if applicable)

- **Environment**: Any compression that triggers a notification.
- **Minimal reproduction steps**:
  1. Run a compression that fires a notification.
  2. Read the rendered `Context X→Y` string — no spaces around `→`.
- **Relevant configuration**: Any config that shows notifications (default).

## 3. Constraints & Non-Goals

- **Constraints**: Match existing module convention (`→ ` with trailing space, used at lines 211, 212, 223; `lib/ui/utils.ts:272`).
- **Non-Goals**: No other notification-formatting changes.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] `formatContextTransition` returns `Context ${beforeStr} → ${afterStr}` (spaces around `→`).
- **Performance / Stability**: N/A (one-character cosmetic change).
- **Regression**: N/A (no logic change).

## 5. Proposed Approach (optional)

- **Affected modules & entry files**: `lib/ui/notification.ts` (single line).
- **Risks**: None.
- **Rollback strategy**: Revert the commit.
