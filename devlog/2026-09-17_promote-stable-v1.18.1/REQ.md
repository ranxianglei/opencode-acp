# REQ — Promote v1.18.1 to npm stable tag

## Goal

Point the npm `stable` dist-tag at `opencode-acp@1.18.1` (currently at 1.14.26, seven releases behind). Users installing via `opencode plugin opencode-acp@stable --global` — the README's recommended install command — receive the current stable release.

Issue: [#400](https://github.com/ranxianglei/opencode-acp/issues/400) "发布新版本专用", floor 6 (ranxianglei, 2026-09-17): "本项目先发一个stable版本".

## Context

- v1.18.1 published to npm `latest` on 2026-09-15T07:13Z (PR #401 merged; release.yml succeeded, tag `v1.18.1` created) and has run as `latest` for ~2 days
- v1.14.26 (promoted 2026-09-03 via PR #358) is still the `stable` pointer — releases 1.14.27 → 1.18.1 never reached `stable`
- Since v1.14.26, `stable` users are missing high-severity fixes: context-limit safety net (#346) + budget guard (#347) in v1.17.0, and the transform performance fix 13.6 s → 1.2 ms (#384/#385) in v1.17.1
- master HEAD (`06efd39c`) = v1.18.1 + PR #403 only in code (Windows path-separator normalization in `lib/protected-patterns.ts`, 6 lines + 104 test lines) plus a CI workflow addition (`publish-stable-from-acp.yml`). No unreleased feature or fix justifies cutting a new version number for this promotion; #403 rides the next patch release

## Mechanism

No code changes. Branch name `2026-09-17_promote-stable-v1.18.1` + commit title `promote: stable v1.18.1 — ...` triggers release.yml Pattern 3 (squash) / Pattern 4 (standard merge), which runs `npm dist-tag add opencode-acp@1.18.1 stable`. Version is extracted from the merge title/branch name by CI — `package.json` is NOT modified, so no changelog entry is required (check-pr.sh skips the changelog check when the version is unchanged).

## Content shipped in stable 1.14.26 → 1.18.1

- **v1.14.27** (#338): self-disable also triggers in manual proxy mode (`/bili/` baseURL detection); soft deprecation of `minContextLimit` / `modelMinLimits` (#352)
- **v1.15.0** (#377): `compress.reasoning` — drop oversized thinking from closed-turn compress calls (fixes the unreclaimable context floor, #368)
- **v1.16.0** (#380): top-level `storagePath` — custom storage location for session state files (#379)
- **v1.17.0** (#349/#350 + four more): context-limit safety net for spawn+resume (fixes #346) + context budget guard (fixes #347) — no more silent HTTP-400 death loops; nudge/exec char-counter alignment (#359); tier-aware cadence reset (#364); reasoning tokens in context estimates (#371); `/acp` error-log leak fix (#296)
- **v1.17.1** (#385/#389/#390): transform no longer scales with compression history (13.6 s → 1.2 ms, fixes #384); `qualityGate.algorithms` false "Unknown keys" warning (#329); fork PR builds green again (#366)
- **v1.18.0** (#341 + follow-ups): adaptive compression candidates (MICRO/EPISODE targets) — opt-in via `compress.candidates`, default OFF is byte-exact v1.17.1 behavior
- **v1.18.1** (#394): paper preprint v0.2 into the repo (docs only)
