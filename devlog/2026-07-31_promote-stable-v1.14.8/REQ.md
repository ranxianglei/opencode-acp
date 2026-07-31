# REQ: Promote v1.14.8 to npm `stable` tag

## Problem
npm `stable` tag is still at `1.14.7` while `latest` is at `1.14.8`. Users installing via `opencode-acp@stable` get the old version.

## Solution
Create a promote-stable PR. On merge, CI runs `npm dist-tag add opencode-acp@1.14.8 stable`.

## Rationale
v1.14.8 has been on `latest` since 2026-07-30 and validated in production. Promoting to `stable` makes it available to conservative users.
