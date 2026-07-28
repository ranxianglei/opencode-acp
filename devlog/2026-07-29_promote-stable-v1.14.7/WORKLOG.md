# WORKLOG: Promote v1.14.7 to npm stable tag

## Steps
1. Created branch `2026-07-29_promote-stable-v1.14.7` from master (`8ba7948`)
2. Created devlog with v1.14.x changelog summary
3. On merge, CI will detect `promote: stable v1.14.7` pattern and run `npm dist-tag add opencode-acp@1.14.7 stable`

## Expected CI behavior
- Merge commit: `promote: stable v1.14.7 (#NNN)` (squash) or `Merge pull request #NNN from .../2026-07-29_promote-stable-v1.14.7` (standard)
- CI Pattern 3/4 detection triggers `npm dist-tag add opencode-acp@1.14.7 stable`
- Result: `stable` tag points to 1.14.7
