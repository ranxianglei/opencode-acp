# WORKLOG: Release v1.13.1

## Pre-release state audit

```
npm latest:  1.12.10
npm 1.13.0:  404 (never published)
npm 1.13.1:  404 (never published)
git tag v1.13.x: none (never created)
master package.json: "version": "1.13.1"
```

Both 1.13.x versions exist in git history but neither was tagged or pushed to npm. The CI `release.yml` workflow only auto-publishes when a merge comes from a `YYYY-MM-DD_release-v*` branch — PR #166 (1.13.0), PR #167 (compress-notification-fix), and PR #168 (cc-alg-extraction) all merged from feature-named branches, so the publish step was skipped each time.

## Recent master history

```
84a8e27 Merge pull request #167 from ranxianglei/2026-07-20_compress-notification-fix
84e1b4e Merge pull request #168 from ranxianglei/2026-07-20_acp-algorithms-extraction
10cd102 refactor: extract quality-gate/prompts/trigger to context-compress-algorithms
d316cfd release: v1.13.1 — compress notification freeze fix
eb684f2 chore: default pruneNotificationType chat → toast
9fa6487 fix: compress notification no longer injects empty user message (closes #20)
0cd78db Merge pull request #166 from ranxianglei/2026-07-19_quality-gate
```

- PR #168 (cc-alg) merged first at 15:04:50Z
- PR #167 (compress-notification-fix) merged after at 15:06:04Z — brought in the `1.13.1` version bump
- Master HEAD now contains both pieces of work at version `1.13.1`

## Steps executed

1. **Branch creation**: `git checkout master && git pull github master && git checkout -b 2026-07-20_release-v1.13.1`
2. **README.md update**: rewrote existing `### v1.13.1` entry to cover both PRs. Original entry only documented compress notification freeze; added "Problem (cc-alg extraction)" and "Fix (cc-alg extraction)" sections plus extended Files/Tests list.
3. **README.zh-CN.md update**: parallel update in Chinese, same structure.
4. **AGENTS.md update**: added 5th row to §5.1.1.1 Git Safety Rules table:
   > **NEVER modify `version` field in `package.json` on non-release branches** — Version bumps happen ONLY on `YYYY-MM-DD_release-v*` branches (see §5.4.2). Regular feature/fix PRs MUST NOT touch the `version` field. The CI changelog check (§5.4.1) enforces this indirectly... Violating this rule causes version-number drift across non-release PRs...
5. **Devlog**: created this `REQ.md` + `WORKLOG.md`.
6. **CI check**: `scripts/ci/check-pr.sh 2026-07-20_release-v1.13.1 origin/master` — passes (branch name regex match, devlog present, changelog entry matches `### v1.13.1`).
7. **Commit + push + PR**: see git log for the exact commit message.

## No code changes in this PR

Intentionally. Release PRs should be bookkeeping-only:

- `package.json` — unchanged (already at `1.13.1` from PR #167)
- `package-lock.json` — unchanged
- `lib/`, `tests/`, `tsup.config.ts`, `tsconfig.json` — unchanged
- No new dependencies

The actual code/content of v1.13.1 was already merged to master via PR #167 (compress notification fix) and PR #168 (cc-alg extraction). This release PR is just the trigger for CI to tag + publish.

## Verification

| Check | Result |
|---|---|
| Branch name regex `^\d{4}-\d{2}-\d{2}_release-v[0-9.]+$` | ✅ matches `2026-07-20_release-v1.13.1` |
| `package.json` version field | ✅ `1.13.1` (inherited from master, no edit needed) |
| `README.md` contains `### v1.13.1` | ✅ entry updated to cover both PRs |
| `README.zh-CN.md` contains `### v1.13.1` | ✅ parallel entry updated |
| devlog REQ.md + WORKLOG.md | ✅ present |
| `scripts/ci/check-pr.sh` local run | ✅ passes |
| Code diff (should be docs only) | ✅ only README.md, README.zh-CN.md, AGENTS.md, devlog/ |

## Post-merge automation

This is a release branch merge, so `release.yml` will execute the full publish pipeline:

1. Detect `head.ref == "2026-07-20_release-v1.13.1"` matches `YYYY-MM-DD_release-v*`
2. `npm ci` for reproducible install
3. `npm run check:package` (build + verify package contents)
4. `npm test` (must pass — expected since master HEAD was already tested in PR #167 and #168)
5. `npm publish` (no `-` in `1.13.1`, so uses `--tag latest`)
6. Create git tag `v1.13.1` and GitHub Release

After publish completes:

```bash
npm view opencode-acp version        # should print 1.13.1
npm view opencode-acp dist-tags      # should show latest: 1.13.1
gh release view v1.13.1 --repo ranxianglei/opencode-acp
```

## Version history after this release

```
npm: 1.12.10 → 1.13.1 (1.13.0 skipped on registry, exists in git history)
git tags: v1.12.10 → v1.13.1 (no v1.13.0 tag — was never formally released)
```

The 1.13.0 commit (`155e410 chore: bump version to 1.13.0 + devlog for quality gate`) remains in git history for archaeological purposes. Anyone curious about what changed between 1.12.10 and 1.13.1 can read the combined changelog entries for `### v1.13.0` (quality gate) and `### v1.13.1` (compress fix + cc-alg) in README.md.
