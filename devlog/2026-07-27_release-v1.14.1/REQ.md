# Release v1.14.1

## Purpose
Publish v1.14.1 stable release to npm `latest` tag.

This release bundles two PRs merged to master since v1.14.0:
- **PR #205**: `feat(log)` — add ACP version to daily logs and context logs (build-time `ACP_VERSION` define via tsup, written to each daily log line as `| v={version}` and to a one-shot `_version` file under each context-log directory)
- **PR #207**: `fix` — preserve growth baseline when `nothingToCompress` is true (removed the `lastPerMessageNudgeTokens = currentTokens` reset that ate accumulated growth in short sessions / subagents, causing a feedback loop where the baseline chased current context and the model never saw a nudge)

## Version
- `package.json`: 1.14.0 → 1.14.1
- Patch bump (small logging feature + bug fix); consistent with the project's pragmatic versioning cadence (cf. v1.13.x patch series).

## Changes (release-only — no source changes)
- `package.json`: version bump
- `README.md`: Added v1.14.1 changelog entry (English)
- `README.zh-CN.md`: Added v1.14.1 changelog entry (中文)
- `devlog/2026-07-27_release-v1.14.1/REQ.md` + `WORKLOG.md`

## Verification
- No source code changes — source identical to master @ `da590e1` (already CI-green on PRs #205 and #207)
- `npm run typecheck` passes
- `npm run build` passes
- `./scripts/ci/check-pr.sh 2026-07-27_release-v1.14.1 github/master` passes

## Release method
- Automated via `release.yml` workflow on PR merge (release branch `YYYY-MM-DD_release-v*` → auto-tag `v1.14.1` → npm publish to `latest` tag → GitHub Release)
- PR merge is a human-only operation per AGENTS.md §5.1.1.2 — Agent prepares PR, human clicks Merge
