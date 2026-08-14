# REQ — Promote v1.14.19 to npm stable tag

## Goal

Point the npm `stable` dist-tag at `opencode-acp@1.14.19` (currently at 1.14.13). Users installing via `opencode plugin opencode-acp@stable --global` receive the latest stable release.

## Context

- v1.14.19 published to npm `latest` (PR #308 merged; release.yml succeeded — pipeline finally fixed after 1.14.17/1.14.18 both failed to publish)
- v1.14.13 was the last version on `stable` — 6 versions behind (14.14, 14.16, 17†, 18†, 19; † never published)
- This PR supersedes #307 which promoted v1.14.18 — that version was never published to npm (release pipeline was broken at the time), so its `npm dist-tag add opencode-acp@1.14.18 stable` would fail

## Mechanism

No code changes. Branch name `2026-08-15_promote-stable-v1.14.19` + squash-merge title `promote: stable v1.14.19 — ...` triggers release.yml Pattern 3, which runs `npm dist-tag add opencode-acp@1.14.19 stable`.

## Content shipped in stable 1.14.13 → 1.14.19

- v1.14.14: batched-call summary leak fix (#288), batch-compress all-or-nothing abort fix (#290)
- v1.14.16: context limits raised to 80% (max/min)
- v1.14.19: per-PR npm preview builds + release publishing feedback (#298, from unpublished 1.14.17), release pipeline fix (from unpublished 1.14.18), npm 10 prepare-hook stdout redirect fix
