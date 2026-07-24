# WORKLOG: Release v1.13.5

## Steps

1. Diagnosed why npm was stuck at 1.13.2:
   - Checked npm: `latest: 1.13.2`
   - Checked GitHub releases: Latest = v1.13.2 (no v1.13.3 or v1.13.4)
   - Checked release.yml workflow runs: v1.13.3 run took only 8s (skipped), v1.13.4 run took 10s (skipped)
   - Read release.yml: detection regex only matches `Merge pull request #N from ..._release-v`
   - Verified: PR #182 and #186 were squash-merged → commit titles don't match regex

2. Created release worktree from merged master (9b340002)

3. Fixed `.github/workflows/release.yml`:
   - Added squash merge detection: `^release: v[0-9]+\.[0-9]+\.[0-9]+`
   - Both patterns now detected (standard + squash)

4. Bumped version: 1.13.4 → 1.13.5

5. Added changelog entries to README.md and README.zh-CN.md

6. Created devlog

7. Verified: typecheck + test + build + CI check

8. Committed (2 commits: CI fix + release bump), pushed, created PR

## Verification

- npm is at 1.13.2 (will be 1.13.5 after this publishes)
- 843 tests pass
- CI pr-checks pass (branch name, devlog, changelog)
