# REQ - Release v1.13.3

- Task ID: `2026-07-23_release-v1.13.3`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-07-23

## Goal

Ship accumulated master commits since v1.13.2 as v1.13.3.

## Scope

Patch release bundling (all opt-in or non-breaking):

1. **Quality gate enforcement** (PR #173) — New optional `qualityGate` config
   (`enabled: false` by default). Pre-commit ROUGE-1 recall + L1 length floor
   evaluation. Rejected compressions return structured error with recovery
   guidance. `qualityGateRetryPending` flag tracks rejection state.
2. **E2E test framework** (PR #174) — `scripts/e2e/` with fake LLM server,
   scripted JSON scenarios, state verifier. 4 baseline scenarios.
3. **Proportional baseline tests** (PR #175) — 18 new tests for baseline
   edge cases.
4. **protectedTools replace fix** (PR #177) — `compress.protectedTools` now
   replaces inherited defaults; explicit `[]` protects nothing.
5. **AGENTS.md no-auto-merge** (PR #179) — §5.1.1.2 absolute prohibition on
   Agent merging PRs.

## Compatibility

- Persisted state format: unchanged.
- Config: new optional `qualityGate` section (disabled by default).
  `compress.protectedTools` semantics change for users who set it explicitly
  (now replaces instead of merging).
- No user-facing behavioral change for default-config users.

## Exit Criteria

- [x] Version bumped in package.json
- [x] Changelog entries in README.md + README.zh-CN.md
- [x] Devlog created
- [x] CI checks pass (branch name, devlog, changelog)
- [ ] PR merged (human confirmation)
- [ ] npm published (automated via release.yml)
