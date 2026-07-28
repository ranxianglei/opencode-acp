# REQ: Add npm `stable` dist-tag promotion via PR

## Problem
npm package only has `latest` (auto-published) and `dev` (prerelease). No way to mark a version as "battle-tested stable". The initial workflow_dispatch approach (manual version input) was rejected — no audit trail for why a version was promoted.

## Solution
PR-based promotion. When a `YYYY-MM-DD_promote-stable-v{VERSION}` branch is merged to master, CI detects the merge commit pattern and runs `npm dist-tag add opencode-acp@VERSION stable`.

The PR itself serves as documentation:
- Branch name embeds the version
- PR description records WHY this version is promoted
- Git history provides full audit trail

CI detects two merge patterns:
- Squash merge: `promote: stable v1.14.7 — ... (#231)`
- Standard merge: `Merge pull request #231 from .../2026-07-29_promote-stable-v1.14.7`

## 3-tier tag system

| Tag | Purpose | How it updates |
|------|---------|----------------|
| `latest` | Auto-published on every stable release | CI on release branch merge |
| `stable` | Manually promoted via PR | Merge `promote-stable-v{VERSION}` branch |
| `dev` | Prerelease | CI on `-` suffix versions |

## Usage
1. Create branch `YYYY-MM-DD_promote-stable-v{VERSION}`
2. Create PR with description explaining what changed since last stable
3. Merge PR
4. CI auto-runs `npm dist-tag add opencode-acp@VERSION stable`
