# REQ - Support custom storage location for compressed content (session state files)

- Task ID: `2026-09-09_custom-storage-path`
- Home Repo: `opencode-acp`
- Created: 2026-09-09
- Status: Done
- Priority: P2
- Owner: ranxianglei
- References: https://github.com/ranxianglei/opencode-acp/issues/379

## 1. Background & Problem Statement

- **Context**: ACP persists per-session compression state (compression blocks, nudge
  anchors, token stats, message ID mappings) to
  `~/.local/share/opencode/storage/plugin/acp/{sessionId}.json`
  (honoring `XDG_DATA_HOME`). The location is hardcoded in
  `lib/state/persistence.ts` (`getStorageDir()`).
- **Current behavior (symptom)**: Users cannot relocate the state directory.
  On systems where the default XDG data dir is small, ephemeral, or shared
  (containers, NFS home dirs, CI runners) the state files land in an
  undesirable place.
- **Expected behavior**: A config option lets the user choose where ACP stores
  session state files, with the current location remaining the default.
- **Impact**: Configuration/ergonomics only — no change to compression
  behavior when the option is unset.

## 2. Reproduction (if applicable)

- **Environment**:
  - Node: 22/24
  - OS/Arch: any
- **Minimal reproduction steps**:
  1) Run opencode with ACP enabled.
  2) Observe state files created under `$XDG_DATA_HOME/opencode/storage/plugin/acp/`
     with no way to move them via configuration.
- **Relevant configuration**: none exists today.

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: with the option unset, the storage location MUST
    be byte-for-byte the current default (`XDG_DATA_HOME || ~/.local/share` +
    `opencode/storage/plugin/acp`). Existing persisted state must keep loading.
  - Performance requirements: no measurable overhead (path resolution happens
    once per session at init).
  - Resource limits: none.
- **Non-Goals** (explicitly out of scope):
  - Automatic migration/copy of existing state files from the default
    location to a newly configured location (a per-session WARN is emitted
    instead when the custom location is empty but the default location holds
    the session file).
  - Per-session or per-project file naming changes.
  - Environment-variable override as a first-class feature (the config option
    is the supported path; `XDG_DATA_HOME` still affects the default).

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [ ] New top-level config option `storagePath` (string, optional) is
    accepted by all three config layers (global / config-dir / project) and
    validated by `config-validation.ts` and `dcp.schema.json`.
  - [ ] Path semantics: absolute → used as-is; `~` / `~/...` → expanded
    against the home directory; relative → resolved against the project
    directory (opencode's `ctx.directory`, fallback `process.cwd()`).
  - [ ] `saveSessionState` writes to the configured directory (created
    recursively if needed); `loadSessionState` reads from it.
  - [ ] Option unset → behavior identical to today (default XDG location).
  - [ ] If state is configured to a custom location, the custom location is
    empty for the session, but the default location contains the session
    file, a WARN is logged (at most once per session) pointing at both paths.
- **Performance / Stability**:
  - [ ] No change to the number of file I/O operations per turn.
- **Regression**:
  - [ ] New test file `tests/storage-path.test.ts` covers path resolution,
    save/load round-trip in a custom directory, and the default-location
    fallback; full suite green.

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
  - `lib/config.ts` — `PluginConfig.storagePath?: string`, `mergeLayer`,
    (deepClone via `...config` spread).
  - `lib/config-validation.ts` — `VALID_CONFIG_KEYS` + type check.
  - `dcp.schema.json` — new `storagePath` property.
  - `lib/state/persistence.ts` — `getDefaultStorageDir()`,
    `resolveStorageDir()`, thread optional `storageDir` through
    `getSessionFilePath` / `writePersistedSessionState` /
    `loadSessionState` / `loadAllSessionStats`; `saveSessionState` reads it
    from `SessionState.storageDir`.
  - `lib/state/types.ts` — transient `SessionState.storageDir` field.
  - `lib/state/state.ts` — `createSessionState` / `resetSessionState` /
    `ensureSessionInitialized` (resolve once per session) /
    `SessionStateRegistry` (new optional `projectDir` constructor arg).
  - `index.ts` — pass `ctx.directory` to the registry.
  - Docs: `CONFIGURATION.md`, `CONFIGURATION.zh-CN.md`, `README.md`,
    `README.zh-CN.md`.
- **Risks**:
  - Relative-path base ambiguity (solved: project dir = `ctx.directory`).
  - Silent state "loss" when switching locations (mitigated by the WARN).
- **Rollback strategy**: revert the PR; option is additive and unset by
  default, so no data migration is needed in either direction.
