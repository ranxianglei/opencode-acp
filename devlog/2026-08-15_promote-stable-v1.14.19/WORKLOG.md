# WORKLOG — Promote v1.14.19 to stable

## Steps

1. Verified v1.14.19 published to npm `latest` (release.yml run 31823530381 completed success; `npm view opencode-acp dist-tags.latest` = 1.14.19)
2. Created branch `2026-08-15_promote-stable-v1.14.19` from master `d6b540e` (post-merge)
3. No code/config changes — promote-only release
4. Supersedes PR #307 (promoted unpublished v1.14.18; would fail at `npm dist-tag add opencode-acp@1.14.18 stable`)

## After merge

release.yml Pattern 3 (squash title `promote: stable v1.14.19 — ...`) runs `npm dist-tag add opencode-acp@1.14.19 stable`. Verify with `npm view opencode-acp dist-tags`.
