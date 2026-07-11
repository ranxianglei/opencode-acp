# WORKLOG - CI Enforcement for Development Standards

- Task ID: `2026-07-11_ci-enforcement`
- Home Repo: `opencode-acp`
- Status: InProgress
- Updated: 2026-07-11 17:40

## 1. Summary

- **What was done**: Added PR validation CI (devlog + branch name + changelog checks) and tag-triggered auto-publish workflow.
- **Why**: AGENTS.md standards were repeatedly violated because enforcement was manual. CI automates the checks.
- **Behavior / compatibility changes**: No
- **Risk level**: Low

## 2. Change Log

### Key Files

- `scripts/ci/check-pr.sh` — PR validation script (branch name, devlog, changelog)
- `.github/workflows/pr-checks.yml` — workflow that runs check-pr.sh on all PRs
- `.github/workflows/release.yml` — workflow that auto-publishes on `v*` tag push

## 3. Design & Implementation Notes

### PR Checks (`scripts/ci/check-pr.sh`)

1. **Branch name**: must match `YYYY-MM-DD_short-title` (regex: `^[0-9]{4}-[0-9]{2}-[0-9]{2}_[a-z0-9.-]+$`)
2. **Devlog**: `devlog/{branch-name}/REQ.md` and `WORKLOG.md` must exist
3. **Changelog**: if `package.json` version differs from base branch, README.md and README.zh-CN.md must be modified and contain `### v{version}` in changelog

### Auto-Publish (`release.yml`)

Triggers on tag push `v*`. Steps: checkout → setup node → npm ci → check:package → test → npm publish (NPM_TOKEN) → GitHub Release.

### Setup Required

User must add `NPM_TOKEN` secret to GitHub repo settings (Settings → Secrets → Actions).

## 4. Testing & Verification

### Test Results

- Script tested locally against `2026-07-11_ci-enforcement` branch: correctly detects missing devlog
- Script tested against `2026-07-11_release-v1.11.1` branch: correctly validates changelog + version match
