# WORKLOG — Promote Stable v1.14.13

## Changes

No code changes. Tag-only release to sync `stable` dist-tag to v1.14.13.

CI workflow detects the branch name `promote-stable-v1.14.13` and runs:
```bash
npm dist-tag add opencode-acp@1.14.13 stable
```
