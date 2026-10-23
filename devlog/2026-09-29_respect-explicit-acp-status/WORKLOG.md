# WORKLOG - Respect explicit acp_status in host permission map

- Task ID: `2026-09-29_respect-explicit-acp-status`
- Home Repo: `opencode-acp`
- Status: Done (extended for #465)
- Updated: 2026-09-29

## 1. Summary

- **What was done**: Extracted the host-permission merge from the plugin factory into a new pure function `applyAcpToolPermissions(permissionConfig, compressPermission)` in `lib/host-permissions.ts`, and made it preserve user decisions on `permission.acp_status` instead of unconditionally rewriting them to `"allow"` — exact own key (#457) AND wildcard keys resolving the tool (`"*"`, `"acp*"`; #465). The inline block in `index.ts` now calls this function.
- **Why**: [#457] — a user config of `{ "permission": { "acp_status": "deny" } }` (no `compress` key) passed the `hasExplicitToolPermission(…, "compress")` guard, then the object spread re-keyed `acp_status` to `"allow"` (later key wins), silently inverting the access decision. The inverted map is cached in `hostPermissions.global`, and the V1 host reads its own permissions from the same object, so the deny was honoured by nobody; recovery required editing config and restarting. [#465] — the #457 fix only checked for an exact own key (`hasOwnProperty`); a user WILDCARD decision resolving `acp_status` (`"*": "deny"`, `"acp*": "deny"`) still got overwritten, because ACP appends its keys last and resolution is last-match. Owner grouped #465 with #457 for a proper fix; the guard now gates on rule resolution instead of key presence.
- **Behavior / compatibility changes**: Yes — user decisions on `permission.acp_status` survive the config hook unchanged instead of being rewritten to `"allow"`:
    - exact own key (`"deny"`/`"ask"`) — from #457, unchanged here;
    - wildcard keys resolving the tool (`"*"`, `"acp*"` — new with #465): old → ACP appended `acp_status: "allow"` which won last-match and silently erased the user's wildcard decision; new → nothing is written, so the host resolves `acp_status` from the user's wildcard (deny stays deny, ask stays ask).
      When no rule resolves `acp_status`, the `"allow"` default is written exactly as before; explicit-`compress` defer behavior and all other keys are unchanged. A denied `acp_status` means the tool is absent from the LLM tool list (opencode semantics) — which is what denying it should do.
- **Risk level**: Low — single assignment site; function is pure and fully unit-tested.

## 2. Change Log

### Commits

| Commit       | Description                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| `(commit 1)` | fix: never override explicit permission.acp_status in host config write (#457)                             |
| `(commit 2)` | fix: respect user wildcard decisions on acp_status in host config write (#465; groups with #457 per owner) |

### Key Files

- `lib/host-permissions.ts` — new export `anyRuleResolves(permissionConfig, tool)`: true when any rule resolves the tool — exact own key in any value form (incl. degenerate empty object via key presence) or a wildcard key (`"*"`, `"acp*"`) matched through the existing rule machinery (`getPermissionRules` + `findLastMatchingRule` + `wildcardMatch`). `applyAcpToolPermissions` now gates the `acp_status` default on `!anyRuleResolves(…, "acp_status")` instead of `hasExplicitToolPermission`. Explicit `compress` rule still returns the map unchanged (same identity); otherwise writes `compress` from ACP config.
- `index.ts` — config hook calls `applyAcpToolPermissions(opencodeConfig.permission, config.compress.permission)` (unchanged by the #465 commit; comment updated). Bili-proxy `denyAcpTools` path untouched (intentional full deny).
- `tests/host-permissions.test.ts` — 6 #457 tests + 8 #465 tests (wildcard `*`/`acp*` deny, wildcard ask/allow, non-matching wildcard still gets default, nested pattern form, wildcard+explicit-compress identity defer, `anyRuleResolves` unit matrix incl. degenerate empty object).
- `devlog/2026-09-29_respect-explicit-acp-status/REQ.md` + `WORKLOG.md` — requirement/worklog docs (extended for #465 scope).

## 3. Design & Implementation Notes

- **Entry point / key function**: `applyAcpToolPermissions` in `lib/host-permissions.ts` (pure; extraction follows AGENTS.md §5.6 since the `index.ts` plugin factory has heavy runtime deps and is not unit-testable directly).
- **Key logic**:
    - `permissionConfig && hasExplicitToolPermission(permissionConfig, "compress")` → return `permissionConfig` as-is (preserves old defer-by-design and object identity; #465 deliberately does NOT extend defer to wildcards — owner scoped the fix to the `acp_status` guard; wildcard-deny on `compress` is already handled by the separate self-disable path via `compressDisabledByOpencode` at `index.ts`).
    - Else build `{ ...permissionConfig, compress: compressPermission }`; add `acp_status: "allow"` only if `!anyRuleResolves(permissionConfig, "acp_status")`.
    - `anyRuleResolves` = key presence (covers degenerate empty-object value form that produces no rules) OR any rule whose permission wildcard-matches the tool name (`getPermissionRules([config])` → `findLastMatchingRule(rules, r => wildcardMatch(tool, r.permission))`). Reuses the exact rule machinery the host resolution models, per the issue's suggested fix.
- **Typing**: SDK `Config.permission` type is narrow (no arbitrary tool keys), so the assignment site keeps the existing `as typeof opencodeConfig.permission` cast pattern.
- **Non-goals kept out**: pre-existing asymmetry where explicit `compress` defers fully and `acp_status` falls back to host default ("ask"); making `dispose` restore the original host object.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck                       # tsc --noEmit — PASS
node --import tsx --test tests/host-permissions.test.ts   # 23/23 pass (15 baseline+457, 8 new for #465)
npm test                                # full suite — see Results
npm run build                           # PASS; applyAcpToolPermissions + anyRuleResolves present in dist/index.js
npx prettier --check <changed files>    # clean
```

### Test Coverage

- Modified file: `tests/host-permissions.test.ts`:
    - 6 #457 tests (unchanged): undefined-map default path; unrelated host rules preserved; explicit `acp_status` deny/ask survive; explicit `compress` → identity defer / no injection.
    - 8 new #465 tests: wildcard `"*": "deny"` not overridden; `"acp*": "deny"` not overridden; wildcard ask → no default; wildcard allow → no redundant default; non-matching wildcard (`"bash*"`) still gets default; nested form `{ acp_status: { "*": "deny" } }` counts as decision; wildcard map + explicit `compress` → identity defer; `anyRuleResolves` unit matrix (undefined / non-matching / exact / `*` / `acp*` / nested / degenerate empty object).
- **RED→GREEN verified**:
    - #457: temporarily reintroduced the unconditional overwrite → exactly the two #457 tests fail (13 pass / 2 fail); restored fix → green.
    - #465: new tests written first against the unfixed guard → file fails to load (`anyRuleResolves` export missing, confirmed as the failure mode); behavioral repro pre-fix showed `{"*":"deny"}` → `{"*":"deny","compress":"allow","acp_status":"allow"}` (wildcard erased); post-fix the same input returns `{"*":"deny","compress":"allow"}`. Full file green (23/23).

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
