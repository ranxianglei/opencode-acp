# WORKLOG: Promote v1.14.8 to npm `stable` tag

## Steps
1. Created branch `2026-07-31_promote-stable-v1.14.8` from master (`e637f57`)
2. Created devlog REQ.md
3. Commit message: `promote: stable v1.14.8 — stable tag update`
4. On merge, CI detects promote-stable pattern → runs `npm dist-tag add opencode-acp@1.14.8 stable`

## No code changes
This is a tag promotion only. No source code, tests, or version numbers modified.
