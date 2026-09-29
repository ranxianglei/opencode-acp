# REQ - Respect explicit `acp_status` in host permission map

- Task ID: `2026-09-29_respect-explicit-acp-status`
- Home Repo: `opencode-acp`
- Created: 2026-09-29
- Status: InProgress
- Priority: P0 (BLOCKER per issue)
- Owner: ework-daemon
- References: https://github.com/ranxianglei/opencode-acp/issues/457

## 1. Background & Problem Statement

- **Context**: The plugin's `config` hook (`index.ts`) writes ACP's own tool permissions into
  opencode's host permission map so that ACP tools are usable by default. When the user has
  not declared an explicit `compress` rule, it writes `{ compress: <acp config>, acp_status: "allow" }`.
- **Current behavior (symptom)**: The spread unconditionally re-keys `acp_status` to `"allow"`,
  silently overwriting an explicit user decision (`"deny"` or `"ask"`) in
  `opencode.json → permission.acp_status`. The inverted map is then cached into
  `hostPermissions.global`, and since the V1 host reads its own permissions from the same
  object, the deny is not honoured by anyone. No log, no error. Recovery requires editing
  the config and restarting.
- **Expected behavior**: An explicit user `permission.acp_status` value must survive the
  config write untouched. The `"allow"` default applies only when the key is absent.
- **Impact**: Silent inversion of an explicit access decision, shipped in the published
  package; any user who denies only `acp_status` (without also declaring a `compress` rule)
  gets the opposite of what they configured.

## 2. Reproduction

- **Environment**:
    - Node: 22+ (any supported)
    - OS/Arch: platform-independent (pure JS object spread)
- **Minimal reproduction steps**:
    1. User config: `{ "permission": { "acp_status": "deny" } }` (no `compress` key).
    2. `hasExplicitToolPermission(permission, "compress")` → `false`, guard passes.
    3. `{ ...{ acp_status: "deny" }, compress: "allow", acp_status: "allow" }` → later key wins
       → `acp_status: "allow"`.
    4. `hostPermissions.global = opencodeConfig.permission` caches the inverted map.
- **Relevant configuration**: `permission.acp_status` in `opencode.json`;
  `compress.permission` in ACP config.

## 3. Constraints & Non-Goals

- **Constraints**:
    - Backward compatibility: users with NO explicit `acp_status` keep getting the `"allow"`
      default (unchanged). Users with an explicit `compress` rule keep full defer behavior
      (unchanged). Bili-proxy denial path (`denyAcpTools`) is intentional and untouched.
    - Performance: pure function, O(map size) — negligible.
    - The SDK `Config.permission` type is narrow (no arbitrary tool keys); keep the existing
      `as typeof permission` cast pattern at the assignment site.
- **Non-Goals** (explicitly out of scope):
    - The pre-existing asymmetry where an explicit `compress` rule defers fully and
      `acp_status` falls back to the host default ("ask") — consistent with defer-by-design.
    - Making `dispose` restore the original host object (no clean hook available; the fix
      removes the mutation hazard for `acp_status`).
    - Bump version / changelog (feature branch; release workflow handles that).

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
    - [ ] Explicit `permission.acp_status: "deny"` survives the config write (value stays `"deny"`).
    - [ ] Explicit `permission.acp_status: "ask"` survives the config write.
    - [ ] Absent `acp_status` still gets the `"allow"` default (with `compress` written from ACP config).
    - [ ] Unrelated host permission keys (e.g. `bash`) are preserved.
    - [ ] Explicit `compress` rule → user owns the map, returned unchanged (identity preserved).
- **Performance / Stability**:
    - [ ] Full test suite + typecheck + build pass.
- **Regression**:
    - [ ] New regression tests added to `tests/host-permissions.test.ts`, verified RED against
          the buggy logic and GREEN after the fix.

## 5. Proposed Approach

- **Affected modules & entry files**:
    - `lib/host-permissions.ts` — new pure export `applyAcpToolPermissions(permissionConfig, compressPermission)`
      (the plugin factory in `index.ts` has heavy runtime deps and is not unit-testable directly;
      AGENTS.md §5.6 mandates extracting pure logic).
    - `index.ts` — replace the 8-line inline block with a call to the extracted function.
    - `tests/host-permissions.test.ts` — regression tests.
- **Risks**: Low — single assignment site, all other consumers read the resulting map only.
- **Rollback strategy**: revert the commit; behavior returns to the buggy overwrite.
