# REQ - Run E2E tests in CI on every PR

- Task ID: `2026-07-25_e2e-in-ci`
- Home Repo: `opencode-acp`
- Created: 2026-07-25
- Status: InProgress
- Priority: P1
- Owner: awork
- References: dog/opencode-acp#33

## 1. Background & Problem Statement

- **Context**: ACP has a full E2E test framework (`scripts/e2e/run-e2e.sh` — fake-LLM architecture, HOME isolation, 5 scenarios) that exercises real `opencode` binary + real ACP plugin + real compression flow. It was added in v1.13.3 (PR #182) and extended with a subagent scenario in PR #192.
- **Current behavior (symptom)**: The E2E suite is NOT wired into any CI workflow. `.github/workflows/ci.yml` only runs `typecheck` + unit tests (`npm test`) + `build`. E2E can only run locally by manual invocation.
- **Expected behavior**: E2E runs automatically on every PR to master, blocking merge until it passes.
- **Impact**: Regressions in the compression pipeline (hooks, state persistence, quality gate, tool registration) that unit tests cannot catch slip through to release. Recent example: PR #192 added a subagent E2E scenario, but without CI enforcement no one is required to run it before merge.

## 2. Reproduction (if applicable)

- **Environment**:
  - CI: GitHub Actions, ubuntu-latest
  - Runtime: node 22, bun (latest), opencode-stable (npm)
- **Minimal reproduction steps**:
  1. Open a PR that breaks `lib/hooks.ts` in a way that unit tests don't cover but E2E would (e.g., plugin fails to load).
  2. CI goes green; bug ships to release.

## 3. Constraints & Non-Goals

- **Constraints**:
  - Backward compatibility: no change to existing `test`/`build` jobs.
  - Performance: E2E runtime must stay under ~10 min (warmup + 5 scenarios × ~4 turns). Keep it off the critical path of the unit-test job by running as a separate job `needs: build`.
  - Resource limits: GitHub Actions free tier minutes. E2E adds ~5-10 min per PR run.
  - No API keys: E2E uses a fake LLM provider bound to 127.0.0.1, so no secrets required.
- **Non-Goals** (explicitly out of scope):
  - Adding new E2E scenarios (only wiring existing ones into CI).
  - Modifying the E2E runner script behavior (`run-e2e.sh`).
  - Making E2E a required branch-protection check (that is a GitHub settings change the human must do after merge).
  - Pinning opencode-stable to a specific version (start with `@latest`; pin later if it causes flakiness).

## 4. Acceptance Criteria (must be testable)

- **Correctness**:
  - [ ] New `e2e` job appears in `.github/workflows/ci.yml`, triggered on PR + push to master.
  - [ ] Job installs `opencode-stable` from npm and runs `scripts/e2e/run-e2e.sh` with `SKIP_BUILD=1`.
  - [ ] Job fails if any of the 5 scenarios fail.
- **Performance / Stability**:
  - [ ] Job completes in under 10 minutes on a clean run.
- **Regression**:
  - [ ] Existing `test` and `build` jobs unchanged.
  - [ ] E2E script still passes locally with the same invocations as before.

## 5. Proposed Approach

- **Affected modules & entry files**:
  - `.github/workflows/ci.yml` — add `e2e` job.
- **Risks**:
  - E2E flakiness from opencode-stable updates (`@latest` tag). Mitigation: start with `@latest`, switch to pinned version if it becomes a problem.
  - First-run opencode DB migration may be slow under load. Mitigation: existing `run-e2e.sh` already does a 300s-timeout warmup step.
  - Bun version drift. Mitigation: `oven-sh/setup-bun@v2` pulls a recent stable release.
- **Rollback strategy**: Revert the single commit; E2E goes back to manual-only with no impact on `test`/`build` jobs.
