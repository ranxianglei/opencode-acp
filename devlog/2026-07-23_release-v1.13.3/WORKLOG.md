# WORKLOG - Release v1.13.3

- Task ID: `2026-07-23_release-v1.13.3`
- Updated: 2026-07-23

## Steps

1. Created release branch `2026-07-23_release-v1.13.3` from master (`253dbb4`).
2. Bumped `package.json` version: `1.13.2` → `1.13.3`.
3. Added changelog entries to `README.md` and `README.zh-CN.md` covering PRs
   #173, #174, #175, #177, #179.
4. Created devlog entry (`REQ.md` + this `WORKLOG.md`).
5. Verified: typecheck, test (836 pass), build.
6. Committed, pushed, created PR.

## Changes Since v1.13.2

| PR    | Type  | Summary                                              |
| ----- | ----- | ---------------------------------------------------- |
| #173  | feat  | Quality gate enforcement (opt-in, ROUGE-1 + L1)     |
| #174  | feat  | E2E test framework (fake LLM + scripted scenarios)  |
| #175  | test  | 18 proportional baseline adjustment tests           |
| #177  | fix   | compress.protectedTools replaces inherited defaults |
| #179  | docs  | AGENTS.md §5.1.1.2 no-auto-merge rule               |

## Notes

- Quality gate is `enabled: false` by default — no behavioral change for
  default-config users.
- This release does NOT include PR #181 (quality-gate rejection prompt), which
  is still open on its feature branch.
