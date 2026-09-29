# WORKLOG - Respect explicit acp_status in host permission map

- Task ID: `2026-09-29_respect-explicit-acp-status`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-09-29

## 1. Summary

- **What was done**: Extracted the host-permission merge from the plugin factory into a new pure function `applyAcpToolPermissions(permissionConfig, compressPermission)` in `lib/host-permissions.ts`, and made it preserve an explicit user `permission.acp_status` instead of unconditionally rewriting it to `"allow"`. The inline block in `index.ts` now calls this function.
- **Why**: [#457] — a user config of `{ "permission": { "acp_status": "deny" } }` (no `compress` key) passed the `hasExplicitToolPermission(…, "compress")` guard, then the object spread re-keyed `acp_status` to `"allow"` (later key wins), silently inverting the access decision. The inverted map is cached in `hostPermissions.global`, and the V1 host reads its own permissions from the same object, so the deny was honoured by nobody; recovery required editing config and restarting.
- **Behavior / compatibility changes**: Yes — explicit `permission.acp_status` values (`"deny"`/`"ask"`) survive the config hook unchanged instead of being rewritten to `"allow"`. When the key is absent, the `"allow"` default is written exactly as before; explicit-`compress` defer behavior and all other keys are unchanged. A denied `acp_status` means the tool is absent from the LLM tool list (opencode semantics) — which is what denying it should do.
- **Risk level**: Low — single assignment site; function is pure and fully unit-tested.

## 2. Change Log

### Commits

| Commit          | Description                                                                    |
| --------------- | ------------------------------------------------------------------------------ |
| `(this commit)` | fix: never override explicit permission.acp_status in host config write (#457) |

### Key Files

- `lib/host-permissions.ts` — new export `applyAcpToolPermissions`: explicit `compress` rule → return the user's map unchanged (same identity); otherwise write `compress` from ACP config + default `acp_status: "allow"` only when the key is absent.
- `index.ts` — config hook: replaced the 8-line inline spread block with `applyAcpToolPermissions(opencodeConfig.permission, config.compress.permission)`; import swap (`hasExplicitToolPermission` → `applyAcpToolPermissions`). Bili-proxy `denyAcpTools` path untouched (intentional full deny).
- `tests/host-permissions.test.ts` — 6 new tests for `applyAcpToolPermissions`, incl. two #457 regression tests.
- `devlog/2026-09-29_respect-explicit-acp-status/REQ.md` — requirement doc.

## 3. Design & Implementation Notes

- **Entry point / key function**: `applyAcpToolPermissions` in `lib/host-permissions.ts` (pure; extraction follows AGENTS.md §5.6 since the `index.ts` plugin factory has heavy runtime deps and is not unit-testable directly).
- **Key logic**:
    - `permissionConfig && hasExplicitToolPermission(permissionConfig, "compress")` → return `permissionConfig` as-is (preserves old defer-by-design and object identity).
    - Else build `{ ...permissionConfig, compress: compressPermission }`; add `acp_status: "allow"` only if `!hasExplicitToolPermission(permissionConfig, "acp_status")`.
- **Typing**: SDK `Config.permission` type is narrow (no arbitrary tool keys), so the assignment site keeps the existing `as typeof opencodeConfig.permission` cast pattern.
- **Non-goals kept out**: pre-existing asymmetry where explicit `compress` defers fully and `acp_status` falls back to host default ("ask"); making `dispose` restore the original host object.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck                       # tsc --noEmit — PASS
node --import tsx --test tests/host-permissions.test.ts   # 15/15 pass
npm test                                # 1346/1348 pass (2 env-only failures, see below)
npm run build                           # PASS; applyAcpToolPermissions present in dist/index.js
npx prettier --check <changed files>    # clean
```

### Test Coverage

- Modified file: `tests/host-permissions.test.ts` — 6 new tests:
    - undefined map → `{ compress, acp_status: "allow" }` (default path unchanged)
    - unrelated host rules preserved (`bash: "ask"`)
    - **#457** explicit `acp_status: "deny"` survives the write
    - **#457** explicit `acp_status: "ask"` survives the write
    - explicit `compress` rule → original object returned by identity
    - explicit `compress: "deny"` → no `acp_status` injected
- **RED→GREEN verified**: temporarily reintroduced the unconditional overwrite → exactly the two #457 tests fail (13 pass / 2 fail); restored fix → full file green.

### Results

- **PASS/FAIL**: PASS (typecheck, build, targeted suite, full suite modulo environment).
- **Environment-only failures (pre-existing in this sandbox, NOT caused by this change)**:
    - `tests/inactive-block-decompress.test.ts` "toFile on inactive block writes block summary" — hard-codes `/tmp/test-inactive-block-decompress.txt`; sandbox `/tmp` handling rejects it (validator requires `.tmp` or `~/.cache/opencode`).
    - `tests/soft-block.test.ts` — `EACCES: mkdir '/tmp/opencode-dcp-dangerous-*'` at import time (read-only `/tmp`).
    - Neither file imports any module changed here (verified by grep); both pass on CI where `/tmp` is writable.

## 5. Risk Assessment & Rollback

- **Risk points**: none identified beyond the intended behavior change (disclosed above). All other consumers read the resulting map only after the assignment.
- **Rollback method**: revert this single commit.
- **Compatibility notes**: No state format, config schema, persistence, or public API change. Internal naming untouched.

## 6. Lessons Learned

- Object-spread "defaults" silently clobber explicit user values when the presence check targets a different key — a guard must check every key it writes, not just one representative key.
- Keeping the permission merge pure (in `host-permissions.ts`) makes this class of regression directly unit-testable without booting the plugin factory.
