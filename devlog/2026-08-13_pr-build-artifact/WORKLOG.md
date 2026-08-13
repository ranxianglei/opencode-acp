# WORKLOG — PR Build Artifact CI

## Changes

1. `.github/workflows/pr-artifact.yml` (new) — CI workflow that:
   - Triggers on `pull_request` to master
   - Builds `dist/`, creates `npm pack` tarball
   - Uploads artifact (tarball + dist/) with 30-day retention
   - Comments on PR with install instructions (idempotent — updates existing comment)

2. `package.json` — Added `"prepare": "npm run build"` script so `npm install github:...#branch` auto-builds `dist/`

## Verification

- Workflow YAML validated manually
- `prepare` script confirmed: runs on git install + before publish, does NOT run on `npm ci`
