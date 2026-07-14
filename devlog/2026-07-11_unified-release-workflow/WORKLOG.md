# WORKLOG - Unified Release Workflow

- Task ID: `2026-07-11_unified-release-workflow`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-07-11 19:00

## 1. Summary

Fixed broken release pipeline by merging `auto-tag.yml` + `release.yml` into a single workflow. The two-workflow chain failed because GitHub Actions `GITHUB_TOKEN` cannot trigger other workflows.

## 2. Root Cause

1. `auto-tag.yml` runs on push to master → detects release branch → creates `v{VERSION}` tag
2. Tag push should trigger `release.yml` (`on: push: tags: ['v*']`)
3. **BUT**: `auto-tag.yml` pushes tag using `GITHUB_TOKEN` → GitHub Actions does NOT fire `release.yml` (by design — prevents recursive workflow chains)

## 3. Fix

Single `release.yml` workflow:

- Triggers on push to master
- Detects release branch merge (`YYYY-MM-DD_release-v*`)
- In one job: creates tag → npm ci → check:package → test → npm publish → GitHub Release
- Also supports `workflow_dispatch` with `force: true` for manual override

## 4. Change Log

- `.github/workflows/release.yml` — rewritten: unified tag + publish in single workflow
- `.github/workflows/auto-tag.yml` — deleted (merged into release.yml)
- `AGENTS.md` Section 5.4 — updated: two workflows (not three), explains why not chained
