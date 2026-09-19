# WORKLOG - Release v1.18.2

## Steps

1. Branched `2026-09-19_release-v1.18.2` from `origin/master` (`026dbe73`, includes merges of #432 + #433).
2. Bumped `package.json` version 1.18.1 → 1.18.2.
3. Added `### v1.18.2` entries at the top of `CHANGELOG.md` + `CHANGELOG.zh-CN.md`.
4. Created this devlog folder (`REQ.md` + `WORKLOG.md`).
5. Local verification (below).
6. Pushed branch + opened release PR (references issue #400 floor 12; does **not** close #400 — long-lived release issue).

## Local verification (2026-09-19)

| Check | Result |
|-------|--------|
| `./scripts/ci/check-pr.sh 2026-09-19_release-v1.18.2 origin/master` | branch name ✓, devlog REQ/WORKLOG ✓, changelog `### v1.18.2` present in both files ✓ |
| `npm run typecheck` | clean |
| `npm run build` | success — `dist/index.js` 484.35 KB |
| `npm test` | **1290/1292** — 2 failures are sandbox-only (hardcoded `/tmp` paths vs this workdir's read-only `/tmp` mount): `tests/soft-block.test.ts` and E2E "toFile on inactive block writes block summary". Pre-existing on master; GitHub CI runners unaffected (PR #433's full CI matrix was green with the same suite). |

## Post-merge (human merge + automated CI)

- Human merges the PR → `release.yml` detects release branch → tags `v1.18.2` → `npm ci` → `check:package` → full test → publishes to npm `latest` → creates GitHub Release.
- Verify after publish: `npm view opencode-acp dist-tags.latest` = 1.18.2; `gh release view v1.18.2`.
- Note: npm `stable` stays at 1.18.1 until a future promote-stable request.
