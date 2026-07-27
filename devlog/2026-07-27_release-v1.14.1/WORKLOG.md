# Worklog: Release v1.14.1

## Step 0: Scope discovery
- Inspected `github/master` (HEAD `da590e1`) vs latest tag `v1.14.0` (`ce248b6`)
- Two unreleased commits on master:
  - `2a2aa07` PR #205 — `feat(log): add ACP version to daily logs and context logs`
  - `da590e1` PR #207 — `fix: preserve growth baseline when nothingToCompress`
- The local `pr-206` branch (`1f47b4d refactor: remove dead prune tool, sweep command, and strategies`) is NOT on master and is excluded from this release.

## Step 1: Worktree + branch
- Created worktree at `/tmp/opencode-acp-release-v1.14.1` from `github/master`
- Branch: `2026-07-27_release-v1.14.1` (matches `YYYY-MM-DD_release-v{VERSION}` per §5.4.2)

## Step 2: Version bump
- `package.json`: `1.14.0` → `1.14.1` (patch — feat+fix bundle)

## Step 3: Changelog
- Added v1.14.1 entry to `README.md` (English) — describes PR #205 (ACP version in logs) and PR #207 (growth baseline fix)
- Added v1.14.1 entry to `README.zh-CN.md` (中文) — same content translated

## Step 4: Devlog
- Created `devlog/2026-07-27_release-v1.14.1/REQ.md` + `WORKLOG.md`

## Step 5: Verify
- `npm run typecheck` — pass
- `npm run build` — pass (sanity; source identical to master)
- `./scripts/ci/check-pr.sh 2026-07-27_release-v1.14.1 github/master` — pass (branch name, devlog, changelog all good)

## Step 6: Commit + push + PR
- Commit message: `release: v1.14.1 — log version info + growth baseline fix`
- Push to `github/2026-07-27_release-v1.14.1`
- Create PR (targeting master)

## Step 7: Merge (human-only — Agent MUST NOT merge per §5.1.1.2)
- Hand off PR URL to the user; await human merge
- On merge, `release.yml` auto-tags `v1.14.1`, publishes to npm `latest`, creates GitHub Release
