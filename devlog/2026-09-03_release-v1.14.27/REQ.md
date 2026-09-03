# REQ — Release v1.14.27

- Task ID: `2026-09-03_release-v1.14.27`
- Home Repo: `opencode-acp`
- Created: 2026-09-03
- Status: In Progress
- Priority: P1
- Owner: ework-daemon
- References: issue ranxianglei/opencode-acp#337, PR ranxianglei/opencode-acp#338, PR ranxianglei/opencode-acp#352, PR ranxianglei/opencode-acp#358

## 1. Background & Problem Statement

- Release the issue #337 fix (self-disable in manual proxy mode — detect the documented `/bili/` prefix in provider `baseURL`, not only via the launcher env var `BILLION_CONTEXT_PROXY`) so it reaches npm `latest`. The fix is merged on master (PR #338, merge commit `6a8e531`) but unreleased — npm `latest` is still 1.14.26.
- The fix branch was a feature branch, not a release branch, so `release.yml` did not tag/publish on merge.
- Maintainer directed after merging PR #338: “合并了 发一个新版本” (merged — cut a new version).
- **Scope**: everything merged since v1.14.26 (tag `c62ba56`): PR #338 (code), PR #352 (soft-deprecate `minContextLimit` / `modelMinLimits` — docs/schema/JSDoc only, no behavior change; `modelMaxLimits` NOT deprecated), PR #358 (promote npm `stable` dist-tag to 1.14.26, bookkeeping).

## 2. Release Contents

- PR #338 (issue #337): config-hook scan of every provider's `options.baseURL` for `/bili/`; on match — permission-deny all five ACP tools (`compress`, `decompress`, `search_context`, `acp_status`, `acp_context_recap`), skip `/acp` command + `primary_tools`, no-op all five hooks, one explanatory log line. Case-sensitive, per-provider; lookalikes (`/bilix/`, `bilibili.com`, bare `/bili`) rejected. Disable flag un-latches on config reload without proxy routing. New pure module `lib/bili-proxy.ts`; 15 new tests (unit + integration through the real plugin factory); full suite 1044/1044.
- PR #352: soft deprecation of `minContextLimit` + `modelMinLimits` (JSDoc `@deprecated` in `lib/config.ts`, `[DEPRECATED …]` descriptions in `dcp.schema.json`, README EN/zh + CONFIGURATION zh doc updates). Both remain fully honored until removed; growth nudges (`minNudgeContextPercent` + `nudgeGrowthTokens`) are the maintained mechanism. No behavior change.
- PR #358: promote npm `stable` dist-tag from 1.14.25 to 1.14.26 (bookkeeping).

## 3. Acceptance Criteria

- [ ] `package.json` version bumped to 1.14.27
- [ ] `CHANGELOG.md` + `CHANGELOG.zh-CN.md` updated with `### v1.14.27`
- [ ] `./scripts/ci/check-pr.sh 2026-09-03_release-v1.14.27 refs/remotes/origin/master` passes
- [ ] typecheck + full test suite pass
- [ ] PR created; human merges → CI auto-publishes to npm `latest` + GitHub Release
