# WORKLOG: Release v1.13.7

## 2026-07-25

### Branch setup
- Created worktree `/home/dog/projects/opencode-acp-release-v1.13.7` from `github/master` at `79c7173`
- Branch: `2026-07-25_release-v1.13.7`

### Changes
- `package.json`: version `1.13.7-dev.1` → `1.13.7`
- `README.md`: Added `### v1.13.7` changelog entry before v1.13.7-dev.1 entry, covering PRs #184, #193, #196
- `README.zh-CN.md`: Added Chinese translation of the same changelog entry
- `devlog/2026-07-25_release-v1.13.7/REQ.md` + `WORKLOG.md`: created

### Bundled PRs (all merged to master since v1.13.7-dev.1)
| PR | Title | Tests |
|----|-------|-------|
| #184 | feat: per-session SessionState registry | 851 |
| #192 | test: E2E scenario for subagent compression | 846 |
| #194 | ci: run E2E tests on every PR | 846 |
| #195 | fix: remove erroneous acknowledgeRisk from E2E scenario 05 | 846 |
| #193 | fix: decompress inactive blocks + acp_status visibility | 859 |
| #196 | fix: preserve first user message to guarantee API validity | 846 |

### Verification
- `./scripts/ci/check-pr.sh`: PASS
- `npm run typecheck`: PASS
- `npm run test`: 846 tests pass
- `npm run build`: PASS
