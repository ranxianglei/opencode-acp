# WORKLOG — Promote stable v1.14.18

## Changes

- devlog only (REQ.md + WORKLOG.md). No code changes.

## Plan

1. PR #306 (v1.14.18 release) merges first → release.yml publishes
   `opencode-acp@1.14.18` to npm `latest` + creates GitHub Release.
2. This PR merges second → release.yml runs
   `npm dist-tag add opencode-acp@1.14.18 stable`.
3. Verify: `npm view opencode-acp dist-tags` → `stable: 1.14.18`.
