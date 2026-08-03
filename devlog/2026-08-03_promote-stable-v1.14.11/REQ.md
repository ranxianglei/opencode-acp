# REQ: Promote v1.14.11 to npm stable tag

## Goal
Update npm `stable` dist-tag from 1.14.8 → 1.14.11.

## Why
`stable` tag is stale (still at 1.14.8). `latest` is already at 1.14.11. Users installing `opencode-acp@stable` should get the latest stable release.

## How
CI detects `promote: stable v1.14.11` commit message → runs `npm dist-tag add opencode-acp@1.14.11 stable`.
