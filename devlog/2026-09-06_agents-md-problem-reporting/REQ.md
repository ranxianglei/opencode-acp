# REQ - AGENTS.md problem discovery & fix reporting clause

- Task ID: `2026-09-06_agents-md-problem-reporting`
- Home Repo: `opencode-acp`
- Created: 2026-09-06
- Status: InProgress
- Priority: P2
- Owner: ranxianglei (agent)
- References: https://github.com/ranxianglei/billion-context/issues/584

## 1. Background & Problem Statement

- **Context**: Agents frequently discover problems while working, and fixes sometimes land without any issue tracking — the problem, its impact, and the fix rationale exist only in a chat thread or nowhere.
- **Current behavior (symptom)**: AGENTS.md §5 covers workflow, git safety, and PR merge prohibition, but says nothing about problems discovered or fixed *along the way*; such fixes can be silent.
- **Expected behavior**: A MANDATORY clause requires that every discovered problem is filed as an issue in the owning project, and every fix is followed by an issue recording the problem + fix (or a PR referencing its issue; issue first, then link). The clause references this project's GitHub address.
- **Impact**: Traceability of all agent-driven fixes across the billion-context family.

## 2. Reproduction (if applicable)

N/A — documentation/policy change.

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: none (docs only).
  - Performance requirements: n/a.
  - Resource limits: n/a.
- **Non-Goals** (explicitly out of scope): no code changes; no CI enforcement (policy lives in AGENTS.md); sibling repos get equivalent clauses via their own PRs (billion-context, billion-context-pi).

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [x] AGENTS.md §5 contains a new subsection "5.1.3 Problem Discovery & Fix Reporting (MANDATORY)" covering both cases: discovered-but-unfixed → file issue; fixed → issue after fix, or PR referencing its issue (`Fixes #N`).
  - [x] Clause references https://github.com/ranxianglei/opencode-acp/issues .
  - [x] `./scripts/ci/check-pr.sh` passes on this branch (branch name + devlog presence).
- **Performance / Stability**: n/a.
- **Regression**:
  - [x] No code changes — no test suite impact.

## 5. Proposed Approach (optional)

- **Affected modules & entry files**:
  - `AGENTS.md` — new subsection §5.1.3 under §5 Contributing, between §5.1.2 (Devlog Requirement) and §5.2 (After Making Changes).
- **Risks**: None (documentation).
- **Rollback strategy**: Revert the single docs commit.
