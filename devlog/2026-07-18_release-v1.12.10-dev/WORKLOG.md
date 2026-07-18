# WORKLOG: v1.12.10-dev.1 Release

## Timeline

### 2026-07-18

- Created release branch `2026-07-18_release-v1.12.10-dev` from `master` @ `4290d23`
- `master` state at branch creation:
  - `4290d23` fix: discrete 5% check intervals when nudge suppressed (#159)
  - `4f5a9c9` fix: protected label only shows triggering tools (#157)
  - `2f534a7` (older) decompress range mode PR #73

### Changes

1. `package.json`: version `1.12.9` → `1.12.10-dev.1`
2. `README.md`: added `### v1.12.10-dev.1` changelog entry
3. `README.zh-CN.md`: added `### v1.12.10-dev.1` changelog entry
4. `devlog/2026-07-18_release-v1.12.10-dev/`: REQ.md + WORKLOG.md

## Verification

Pre-commit:
- TypeScript: 0 errors
- Tests: 757/757 pass (Node v25.9.0)
- Build: clean

Post-merge (CI):
- `pr-checks.yml`: branch name + devlog + changelog validation
- `ci.yml`: typecheck + test + build on Node 22/24
- `release.yml`: detects `1.12.10-dev.1` contains `-` → publishes with `--tag dev`, creates prerelease GitHub Release

## Notes

- PR #158 was closed as superseded by PR #159 (which included #158's commits + test fixes + Scenario A coverage)
- PR #159's squash merge included the test fidelity fix from Oracle #2's review (4 tests fixed to actually exercise `allProtected` branch, +1 new Scenario A test)
- npm `latest` tag remains at `1.12.9` — only `dev` tag will get `1.12.10-dev.1`
