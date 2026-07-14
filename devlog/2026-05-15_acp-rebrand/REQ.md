# REQ - DCP → ACP Rebrand

- Task ID: `2026-05-15_acp-rebrand`
- Home Repo: `opencode-acp`
- Created: 2026-05-15
- Status: Done
- Priority: P0
- Owner: ranxianglei
- References: Forked from `@tarquinen/opencode-dcp` v3.1.11

## 1. Background & Problem Statement

- **Context**: Forked opencode-dcp (Dynamic Context Pruning) with 35 bug fixes applied. The fork needs its own identity separate from upstream DCP.
- **Current behavior (symptom)**: All user-visible text, commands, storage paths, and config files reference "DCP" — the upstream project name.
- **Expected behavior**: Full rebrand to "ACP" (Active Context Pruning) across all user-facing surfaces while maintaining backward compatibility with existing DCP installations.
- **Impact**: Without rebranding, users cannot distinguish ACP from upstream DCP, and npm package name conflicts prevent independent publishing.

## 2. Reproduction (if applicable)

- N/A — this is a branding/packaging change, not a bug.

## 3. Constraints & Non-Goals

- **Constraints**:
    - Backward compatibility: Existing `/dcp` command must continue to work
    - Storage migration: `plugin/dcp/` state must be auto-migrated to `plugin/acp/`
    - Config migration: `dcp.jsonc` must be auto-migrated to `acp.jsonc`
    - Internal code tags (`dcp-message-id`, `dcp-system-reminder`) must NOT change — they appear in persisted state and LLM interactions
- **Non-Goals**:
    - Changing internal XML tags or regex variable names (backward compat required)
    - Changing the API or behavior of the plugin

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
    - [x] `/acp` command works and shows ACP branding
    - [x] `/dcp` command still works as backward-compatible alias
    - [x] Storage auto-migrates from `plugin/dcp/` to `plugin/acp/`
    - [x] Config auto-migrates from `dcp.jsonc` to `acp.jsonc`
    - [x] All user-visible text says "ACP" not "DCP"
- **Performance / Stability**:
    - [x] No performance regression from migration logic
- **Regression**:
    - [x] Existing tests pass after rename
    - [x] `npm run build` succeeds
        - [x] `npm publish` succeeds (resolved 3 TS errors blocking publish)

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
    - `lib/commands/` — rename command registration
    - `lib/config.ts` — config migration logic
    - `lib/state/persistence.ts` — storage migration
    - `lib/messages/inject/inject.ts` — context usage text
    - `lib/prompts/` — all prompt templates
    - `README.md` — full rewrite with migration guide
    - `package.json` — npm package rename
- **Risks**: Breaking existing DCP installations if migration fails silently
- **Rollback strategy**: Revert to DCP naming; `/dcp` command remains functional as fallback
