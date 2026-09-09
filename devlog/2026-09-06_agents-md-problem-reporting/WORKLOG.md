# WORKLOG - AGENTS.md problem discovery & fix reporting clause

- Task ID: `2026-09-06_agents-md-problem-reporting`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-09-06 22:25

## 1. Summary

- **What was done**: Added a MANDATORY subsection "5.1.3 Problem Discovery & Fix Reporting" to AGENTS.md §5 requiring issue tracking for every discovered problem and for every fix (issue first, PR references it via `Fixes #N`).
- **Why** (sibling of issue ranxianglei/billion-context#584): fixes discovered/made by agents were not required to leave a trace in the project's issue tracker; the clause makes that mandatory and points at this project's GitHub address.
- **Behavior / compatibility changes**: No (documentation only).
- **Risk level**: Low.

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| head of this branch | docs: AGENTS.md — require issue tracking for discovered/fixed problems |

### Key Files

- `AGENTS.md` — new subsection §5.1.3 under §5 Contributing, between §5.1.2 (Devlog Requirement) and §5.2 (After Making Changes).
- `devlog/2026-09-06_agents-md-problem-reporting/REQ.md`, `WORKLOG.md` — this entry (required by pr-checks CI).

## 3. Design & Implementation Notes

- Clause covers both directions requested in the source issue: (a) problem discovered (in this project or a sibling) → file an issue in the owning project; (b) problem fixed → after the fix, submit an issue recording problem + fix, or ship the PR referencing its issue (`Fixes #N`) — a bare PR without an issue is not acceptable; an existing PR counts but should carry an accompanying issue.
- References https://github.com/ranxianglei/opencode-acp/issues per "agents.md 引用对应的项目地址".

## 4. Testing & Verification

### Build & Test Commands

```sh
./scripts/ci/check-pr.sh 2026-09-06_agents-md-problem-reporting origin/master
```

Docs-only change — build/test suite not required.

### Results

- **PASS/FAIL**: PASS (check-pr.sh: branch name + devlog presence verified).

## 5. Risk Assessment & Rollback

- **Risk points**: none.
- **Rollback method**: revert the single docs commit.
- **Compatibility notes**: No.
