# REQ - Release v1.18.4

- Task ID: `2026-10-15_release-v1.18.4`
- Home Repo: `opencode-acp`
- Created: 2026-10-15
- Status: InProgress
- Priority: P1
- Owner: ranxianglei
- References: issue #400 (release thread); PR #479 closing #478 (image archive); one-click release fallback PR #480

## Goal

Cut stable release **v1.18.4**, bundling the image-archive feature (#478, PR #479) that landed on master after v1.18.3.

## Context

The one-click release workflow auto-bumped `package.json` + `package-lock.json` 1.18.3 → 1.18.4 and opened fallback PR #480 (direct push blocked by branch protection). `pr-validation` failed because the workflow does not generate the AGENTS.md §5.4.2 artifacts (devlog REQ/WORKLOG + changelog entries). This commit completes those artifacts so #480 can merge and `release.yml` can publish v1.18.4.

## Content shipped since v1.18.3

1. **feat: image archive** (#478, PR #479) — spill data-URL images at index time (`archiveSessionImages`), inject absolute-path re-read pointers into folded range summaries (`appendArchivedImagePointers`), TTL sweep (`pruneImageArchive`); new default-on config `compress.images { enabled=true, minBytes=16384, ttlDays=7 }`, excluded from per-model override cascade.
2. **fix: keep compress.images out of cascade blanket-apply** (#478) — `'images'` added to `OVERRIDE_BLANKET_APPLY_EXCLUDE` so a misplaced user entry under `compress.providers/<p>` / `.models/<m>` can no longer wholesale-replace the global images config; regression test added.

## Behavior change to flag

New default-on behavior: data-URL images ≥ 16 KB are copied to local disk each session turn and pointer lines are appended to folded summaries (previously silently dropped when folded). Opt-out: `compress.images.enabled=false`. Additive state field `SessionState.imageArchive`; no breaking state-format change.
