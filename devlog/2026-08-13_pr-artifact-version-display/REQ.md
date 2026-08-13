# REQ — PR Artifact Version Display

## Problem
PR #298's bot comment showed the npm tag (`pr-298`) but not the actual published version number. Users couldn't verify which version corresponds to the current PR state on npm.

## Fix
Pass the published version from the npm publish step to the PR comment step via GITHUB_OUTPUT. The comment now shows:
```
**Published:** `opencode-acp@1.14.16-pr.298.5`
Current version: `1.14.16-pr.298.5` (npm tag `pr-298`)
```
