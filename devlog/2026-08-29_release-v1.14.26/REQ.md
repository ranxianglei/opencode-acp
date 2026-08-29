# REQ — Release v1.14.26

- Task ID: `2026-08-29_release-v1.14.26`
- Home Repo: `opencode-acp`
- Created: 2026-08-29
- Status: In Progress
- Priority: P1
- Owner: ework-daemon
- References: issue ranxianglei/opencode-acp#342, PR ranxianglei/opencode-acp#343, PR ranxianglei/opencode-acp#351

## 1. Background & Problem Statement

- Release the issue #342 fix (T1 growth nudges respect the `minNudgeContextPercent` floor) so it reaches npm `latest`. The fix is merged on master (PR #343, merge commit `574c1c4`) but unreleased — npm `latest` is still 1.14.25.
- The fix branch was a feature branch, not a release branch, so `release.yml` did not tag/publish on merge.
- Reporter (bernhardberger) is waiting for the fix on `latest` before restoring `nudgeGrowthTokens: 50000` and verifying T1 growth nudges stay suppressed below his configured 150K floor (`minNudgeContextPercent: 37.5` on his 400K model).
- **Scope extension (2026-08-29, post #351 merge)**: PR #351 (per-provider/per-model overrides for ALL compress fields via nested `compress.providers`, issue #344) merged into master (`46014bc`) while this release PR was open. Maintainer directed: “合并了 发一个新版本” — the release must ship #343 + #351 together, so master was merged into the release branch and the changelog/devlog extended. PR #352 (soft-deprecate `minContextLimit`/`modelMinLimits`, docs-only) remains open and is NOT part of this release.

## 2. Release Contents

- PR #343 (issue #342): growth-nudge floor via `minNudgeContextPercent` (default 5%, `0` disables; over-max and 98% emergency bypass; T2/T3 unaffected), docs corrections (stale 45%/55% → 80%/80% defaults; `minContextLimit` vs `minNudgeContextPercent` semantics), 6 new/updated tests in `tests/inject.test.ts`.
- PR #351 (issue #344): nested `compress.providers` — any compress field overridable per provider/model (23 fields; model > provider > global per field; nested `maxContextLimit` > flat `modelMaxLimits` > global; 3-layer deep-merge), strict validation + JSON schema, 17+ new tests, README/CONFIGURATION EN+zh docs.

## 3. Acceptance Criteria

- [ ] `package.json` version bumped to 1.14.26
- [ ] `CHANGELOG.md` + `CHANGELOG.zh-CN.md` updated with `### v1.14.26`
- [ ] `./scripts/ci/check-pr.sh 2026-08-29_release-v1.14.26 origin/master` passes
- [ ] typecheck + full test suite pass
- [ ] PR created; human merges → CI auto-publishes to npm `latest` + GitHub Release
