# REQ — Promote v1.14.26 to npm stable tag

## Goal

Point the npm `stable` dist-tag at `opencode-acp@1.14.26` (currently at 1.14.19, seven versions behind). Users installing via `opencode plugin opencode-acp@stable --global` receive the latest stable release.

Issue: [#356](https://github.com/ranxianglei/opencode-acp/issues/356) "发布一个 stable 版本 pr".

## Context

- v1.14.26 published to npm `latest` on 2026-08-29 (PR #353 merged; release.yml succeeded) and has been running as `latest` for ~5 days
- v1.14.19 (promoted 2026-08-15 via PR #309, squash commit `df0b194`) is still the `stable` pointer — versions 1.14.20–1.14.26 never reached `stable`
- master HEAD (`ba5ef36`) is v1.14.26 + PR #352 only (soft deprecation marking of `minContextLimit`/`modelMinLimits`: 11 lines in `lib/config.ts` + docs/schema; no behavior change). No unreleased feature or fix justifies cutting a new version number for this promotion.

## Mechanism

No code changes. Branch name `2026-09-03_promote-stable-v1.14.26` + commit title `promote: stable v1.14.26 — ...` triggers release.yml Pattern 3 (squash) / Pattern 4 (standard merge), which runs `npm dist-tag add opencode-acp@1.14.26 stable`. Version is extracted from the merge title/branch name by CI — `package.json` is NOT modified.

## Content shipped in stable 1.14.19 → 1.14.26

- v1.14.20 (#316): post-v1.14.19 fix batch (modelContextLimit, inactive-block decompress, logging)
- v1.14.21 (#317): /acp command fixes and completion (permission gate, export, help)
- v1.14.22 (#323): stable system prompt token estimate (#255)
- v1.14.23 (#331): fix batch (#325 #326 #327 #328)
- v1.14.24 (#333): default-on decision-level logging
- v1.14.25 (#336): self-disable under billion-context proxy (`BILLION_CONTEXT_PROXY`)
- v1.14.26 (#353): per-provider/per-model `compress.providers` overrides (#351); growth nudges respect the `minNudgeContextPercent` floor (#343)

## Known risks (accepted, tracked separately)

- #346 / #347 (context-overflow death loop on resume with custom providers) are fixed by open PRs #348/#349/#350, not yet merged. These bugs affect current `stable` (1.14.19) and `latest` (1.14.26) users equally — promoting does not introduce a regression. Will be covered by the next release after those PRs land.
