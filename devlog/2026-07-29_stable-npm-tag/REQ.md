# REQ: Add npm `stable` dist-tag support

## Problem
npm package only has `latest` (auto-published on every release) and `dev` (prerelease). No way to mark a version as "battle-tested stable" separately from the auto-published `latest`.

## Solution
Add a `workflow_dispatch` input `promote_stable` to the release workflow. When triggered with a version string (e.g. `1.14.7`), it runs `npm dist-tag add opencode-acp@VERSION stable`.

This creates a 3-tier npm tag system:
- **`latest`** — auto-published on every stable release (npm default, `npm install opencode-acp` gets this)
- **`stable`** — manually promoted by user via GitHub Actions UI when a version is battle-tested
- **`dev`** — prerelease (versions with `-` suffix)

Users install stable via `opencode-acp@stable` or in opencode config: `"opencode-acp": "stable"`.

## Usage
GitHub Actions → Release workflow → Run workflow → set `promote_stable` to the version (e.g. `1.14.7`).

## Files
- `.github/workflows/release.yml` — added `promote_stable` input + `promote-stable` job
