# WORKLOG - Run E2E tests in CI on every PR

- Task ID: `2026-07-25_e2e-in-ci`
- Home Repo: `opencode-acp`
- Status: InProgress
- Updated: 2026-07-25 14:15

## 1. Summary

- **What was done** (1–3 sentences): Added an `e2e` job to `.github/workflows/ci.yml` that installs `opencode-stable` + `bun`, then runs `scripts/e2e/run-e2e.sh` against the 5 E2E scenarios on every PR and push to master.
- **Why** (1–3 sentences): The E2E suite existed (v1.13.3, PR #182; extended #192) but was never wired into CI, so regressions in the compression pipeline that unit tests cannot catch could ship to release unchallenged.
- **Behavior / compatibility changes**: No. Existing `test` and `build` jobs are unchanged; only a new job is added.
- **Risk level**: Low — additive only, no production code changes.

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `<pending>` | ci: run E2E tests on every PR |

### Key Files

- `.github/workflows/ci.yml` — added `e2e` job (needs: build; installs bun + opencode-stable; runs `SKIP_BUILD=1 ./scripts/e2e/run-e2e.sh`).

## 3. Design & Implementation Notes

- **Entry point / key function**: `.github/workflows/ci.yml` → `e2e` job.
- **Key configuration items**:
  - `needs: build` — E2E runs after the existing build pipeline, not in parallel with the unit-test matrix, to keep CI cost predictable.
  - `npm install -g opencode-stable` — installs the ranxianglei stable fork (`bin: opencode`) from npm. No API key needed because E2E uses a fake LLM provider on 127.0.0.1.
  - `oven-sh/setup-bun@v2` — Bun is required by `scripts/e2e/fake-llm-server.ts`.
  - `SKIP_BUILD=1` — the workflow already builds ACP in a prior step, so the runner script skips its own `npm run build`.
- **Key logic explanation** (if non-trivial):
  - Why separate job (not added to `test` matrix)? The `test` job runs a 2x matrix (node 22/24). E2E only needs one node version and one bun; running it per-matrix node version would double cost without value.
  - Why `needs: build`? To fail fast if the build job itself fails, and to avoid spending ~10 min on E2E when the build is already broken.
  - Why `@latest` not pinned? opencode-stable rarely introduces breaking changes, and unpinned gives us automatic compatibility fixes. Can pin later if flakiness appears.

## 4. Testing & Verification

### Build & Test Commands

```sh
# Build
cd opencode-acp && npm run build

# Run unit tests (unchanged)
npm test

# Run E2E locally (uses ~/.local/bin/opencode + bun)
./scripts/e2e/run-e2e.sh

# Simulate the CI invocation exactly
SKIP_BUILD=1 ./scripts/e2e/run-e2e.sh
```

### Local Verification

- [x] `npm run build` passes
- [x] `SKIP_BUILD=1 ./scripts/e2e/run-e2e.sh` — scenarios 01–04 all pass (exit 0)
- [x] `scripts/ci/check-pr.sh 2026-07-25_e2e-in-ci github/master` passes
- [ ] GitHub Actions `e2e` job runs green on the PR

### Scenario 05 — known failure, excluded from CI

Scenario `05-subagent-compress.json` (added in PR #192, commit c149686) **deterministically fails** on master. The fake LLM correctly emits a child compress call (`compress: m00001..m00003, summary=647 chars, ack=true`), but the child session's ACP state has **0 blocks**. Both parent and child state files show `modelContextLimit: undefined`.

This is the same symptom the per-session state work (PR #184, in progress) is meant to fix: the shared SessionState singleton doesn't capture `modelContextLimit` for subagent sessions, so the subagent's compress pipeline cannot allocate a block.

**Decision**: CI runs scenarios 01–04 explicitly (via positional args, which `run-e2e.sh` already supports). Scenario 05 is excluded until PR #184 lands and 05 passes. The exclusion is a single editable arg list in `ci.yml` — trivially reversible.

### CI Job Shape

```yaml
e2e:
    runs-on: ubuntu-latest
    needs: build
    steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
              node-version: 22
              cache: npm
        - run: npm ci
        - run: npm run build
        - uses: oven-sh/setup-bun@v2
        - run: npm install -g opencode-stable
        - run: |
              SKIP_BUILD=1 ./scripts/e2e/run-e2e.sh \
                scripts/e2e/scenarios/01-basic-compress.json \
                scripts/e2e/scenarios/02-quality-reject.json \
                scripts/e2e/scenarios/03-quality-acknowledge.json \
                scripts/e2e/scenarios/04-batch-compress.json
```

## 5. Follow-Up

- **Required check**: After merge, a human must add `e2e` to the GitHub branch protection required checks list on `master`. The Agent cannot do this (settings change, not a code change).
- **Re-enable scenario 05**: When PR #184 (per-session SessionState) lands and `05-subagent-compress.json` passes, remove the explicit scenario args from `ci.yml` so `run-e2e.sh` goes back to globbing all scenarios (`scripts/e2e/scenarios/*.json`). Until then, scenario 05 is excluded because it deterministically fails on master (see "Scenario 05" note above).
- **Pinning**: If opencode-stable `@latest` causes flakiness, switch to a pinned version (e.g., `opencode-stable@1.14.43`).
- **Scenario coverage**: The 4 active scenarios cover basic compress, quality reject, quality acknowledge, and batch compress. Future E2E scenarios for `decompress` / `recompress` / `search_context` would automatically be picked up once the explicit arg list is removed.
