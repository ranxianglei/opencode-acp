# REQ - Unified Release Workflow

- Task ID: `2026-07-11_unified-release-workflow`
- Home Repo: `opencode-acp`
- Created: 2026-07-11
- Status: Done
- Priority: P0
- Owner: awork

## 1. Background

The two-workflow approach (`auto-tag.yml` creates tag → `release.yml` triggered by tag) does NOT work. GitHub Actions does not allow workflows pushed by `GITHUB_TOKEN` to trigger other workflows. The tag pushed by `auto-tag.yml` doesn't fire `release.yml`'s `on: push: tags:` trigger.

**Evidence**: PR #111 merged → `auto-tag.yml` created `v1.11.3` tag ✓ → `release.yml` NOT triggered → npm stayed at 1.11.2.

## 2. Solution

Merge `auto-tag.yml` and `release.yml` into a single `release.yml` workflow:

- Triggers on push to master
- Detects release branch merge → creates tag + builds + tests + publishes — all in one job
- No chained workflows

## 3. Acceptance Criteria

- [x] `auto-tag.yml` deleted (merged into `release.yml`)
- [x] `release.yml` rewritten: push to master → detect release branch → tag + build + test + publish + GitHub Release
- [x] `workflow_dispatch` with `force` input for manual override
- [x] AGENTS.md Section 5.4 updated
