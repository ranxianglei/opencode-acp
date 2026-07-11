# WORKLOG - Auto-Tag on Release Branch Merge

- Task ID: `2026-07-11_auto-tag-on-merge`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-07-11 18:30

## 1. Summary

Added `auto-tag.yml` GitHub Actions workflow that automatically creates a version tag when a release branch (`YYYY-MM-DD_release-v*`) is merged to master. The tag then triggers `release.yml` for auto-publish. Also updated AGENTS.md Section 5.4 with full auto-tag documentation.

## 2. Change Log

- `.github/workflows/auto-tag.yml` — new workflow: detects release branch merge, reads package.json version, creates tag
- `AGENTS.md` Section 5.4 — rewritten with auto-tag flow (supersedes PR #109)
- `devlog/2026-07-11_auto-tag-on-merge/` — REQ.md + WORKLOG.md

## 3. Pipeline Flow

1. Release PR created → `pr-checks.yml` validates (branch name, devlog, changelog)
2. Release PR merged → `auto-tag.yml` creates `v{VERSION}` tag
3. Tag pushed → `release.yml` runs → build + test + publish + GitHub Release
