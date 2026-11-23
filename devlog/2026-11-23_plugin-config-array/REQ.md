# REQ - Fix plugin configuration example in README

- Task ID: `2026-11-23_plugin-config-array`
- Home Repo: `opencode-acp`
- Created: 2026-11-23
- Status: Done
- Priority: P2
- Owner: y-yaoyyy
- References: no issue; reported directly from OpenCode 2.x config validation

## 1. Background & Problem Statement

- **Context**: `opencode-acp` supports OpenCode 1.x, but the README installation section is also read by users who are migrating from OpenCode 1.x to 2.x.
- **Current behavior (symptom)**: The README shows `"plugin": { "opencode-acp": "stable" }`. OpenCode's current config schema requires `plugin` to be an array; using the object form fails validation with `plugin: must be array`.
- **Expected behavior**: The README shows the array form (`"plugin": ["opencode-acp@stable"]`) and keeps the CLI install command unchanged.
- **Impact**: Users copying the documented snippet hit a config error before they can evaluate the plugin.

## 2. Reproduction (if applicable)

- **Environment**:
  - OpenCode: 2.2.5 (the schema requirement applies to current OpenCode)
  - OS/Arch: win32-x64
- **Minimal reproduction steps**:
  1. Put `"plugin": { "opencode-acp": "stable" }` in `opencode.jsonc`.
  2. Start OpenCode.
  3. Observe config validation reject the object form because `plugin` must be an array.
- **Relevant configuration**:

  ```jsonc
  // broken
  "plugin": { "opencode-acp": "stable" }

  // correct
  "plugin": ["opencode-acp@stable"]
  ```

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: no runtime behavior change; documentation only.
  - Performance requirements: none.
  - Resource limits: none.
- **Non-Goals**:
  - Do not change the supported OpenCode version range.
  - Do not add a migration tool.

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] `README.md` uses the array form.
  - [x] `README.zh-CN.md` uses the array form.
  - [x] The CLI install command is still documented and valid.
- **Performance / Stability**:
  - [x] No source or test changes.
- **Regression**:
  - [x] No new test cases are needed for a docs-only change; CI validation passes.

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
  - `README.md`
  - `README.zh-CN.md`
  - `devlog/2026-11-23_plugin-config-array/REQ.md`
  - `devlog/2026-11-23_plugin-config-array/WORKLOG.md`
- **Risks**: none beyond stale docs.
- **Rollback strategy**: revert the docs commit.