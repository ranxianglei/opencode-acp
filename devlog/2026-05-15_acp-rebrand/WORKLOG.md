# WORKLOG - DCP → ACP Rebrand

- Task ID: `2026-05-15_acp-rebrand`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-05-18

## 1. Summary

- **What was done**: Full DCP → ACP rebrand across all user-visible surfaces: command rename (`/dcp` → `/acp`), storage isolation (`plugin/dcp/` → `plugin/acp/`), config migration (`dcp.jsonc` → `acp.jsonc`), README rewrite, version bump to 1.0.1.
- **Why**: Fork needed its own identity separate from upstream DCP, with backward compatibility for existing installations.
- **Behavior / compatibility changes**: Yes — `/acp` is the primary command, `/dcp` is backward-compatible alias. Storage and config auto-migrate on first access.
- **Risk level**: Medium — migration logic must handle edge cases (existing dcp.jsonc, fallback paths)

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `1c4bcd5` | fix(Bug 35): suppress aging warnings below 50% context usage |
| `ca811c9` | rename: /dcp command → /acp (backward compatible, accepts both) |
| `25cc269` | docs: update README with Bug 35 and /acp command rename |
| `ba3db52` | rebrand: DCP → ACP in all user-visible injected text |
| `0ba85fa` | docs: full DCP→ACP rebrand in README + migration guide |
| `c5faeb8` | fix: add ACP full name and role definition to context usage injection |
| `ab72cd5` | feat: isolate storage from DCP - migrate plugin/dcp/ to plugin/acp/ |
| `a0bf36a` | fix: resolve 3 TS errors blocking npm publish + redesign README |
| `4fa2155` | feat: auto-migrate config and prompts from dcp to acp naming |
| `a6752a7` | fix: config migration runs even when dcp.jsonc fallback exists |
| `d9ed83c` | fix: use logger instead of console.log for storage migration |
| `9de007f` | chore: bump version to 1.0.1 |

### Key Files

- `lib/commands/index.ts` — Command registration: `/acp` primary, `/dcp` alias
- `lib/config.ts` — Three-layer config migration (global, config-dir, project)
- `lib/state/persistence.ts` — Storage migration: `plugin/dcp/` → `plugin/acp/`
- `lib/messages/inject/inject.ts` — Context usage injection text updated to ACP branding
- `lib/prompts/system.ts` — System prompt rebrand
- `README.md` — Full rewrite with migration guide, bug fix table, feature documentation
- `package.json` — Package name → `opencode-acp`, version → 1.0.1

## 3. Design & Implementation Notes

- **Entry point / key function**: `getConfig()` in `config.ts` handles auto-migration at config load time
- **Key configuration items**: Config search paths now look for `acp.jsonc` first, fall back to `dcp.jsonc`
- **Key logic explanation**: Migration is copy-based (not rename) so users can revert. If `acp.jsonc` doesn't exist but `dcp.jsonc` does, the file is copied. This runs at every config load, making it idempotent.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run build        # Passes
npm run typecheck    # Passes
npm run test         # 95 tests (baseline), all pass
```

### Test Coverage

- Existing DCP test suite adapted for ACP naming (10 test fixes in `d5f1540`)
- No new tests added in this iteration

### Results

- **PASS**: Build succeeds, tests pass, npm publish succeeds
- **Key data**: Version 1.0.1 published to npm as `opencode-acp`

## 5. Risk Assessment & Rollback

- **Risk points**: Config migration edge case where both `acp.jsonc` and `dcp.jsonc` exist with different contents
- **Rollback method**: Revert to DCP naming; `/dcp` command remains functional
- **Compatibility notes**: Internal `dcp` tags preserved (Section 2.6 of AGENTS.md)

## 6. Lessons Learned

- What went well: Backward-compatible command alias (`/dcp` still works) prevented breakage
- What could be improved: Should have created AGENTS.md during this iteration (done in test iteration)
- Reusable conclusions: Copy-based migration (not rename) is safer for user data
