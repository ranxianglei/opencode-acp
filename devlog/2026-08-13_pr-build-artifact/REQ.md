# REQ — PR Build Artifact CI

## Problem

Users have no easy way to test PR changes locally before merge. They have to clone the branch, install dependencies, build, and manually deploy — too many steps for casual testing.

## Solution

1. New GitHub Actions workflow (`pr-artifact.yml`) that runs on every PR to master:
   - Builds `dist/`
   - Creates an installable tarball via `npm pack`
   - Uploads both as a GitHub Actions artifact (30-day retention)
   - Comments on the PR with install instructions (updated on each push)

2. Add `"prepare": "npm run build"` to `package.json` so `npm install github:...#branch` auto-builds `dist/`.

## Install Options for Testers

**Option A** — Install from GitHub (recommended):
```bash
opencode plugin "github:ranxianglei/opencode-acp#branch-name" --global
```

**Option B** — Download artifact from Actions tab:
1. Download the artifact from the PR's CI run
2. Extract tarball and copy to cache dir
3. Restart opencode
