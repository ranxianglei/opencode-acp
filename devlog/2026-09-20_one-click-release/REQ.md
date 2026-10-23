# REQ - One-click release workflow (workflow_dispatch)

- Task ID: `2026-09-20_one-click-release`
- Home Repo: `opencode-acp`
- Created: 2026-09-20
- Status: InProgress
- Priority: P2
- Owner: ranxianglei
- References: https://github.com/ranxianglei/opencode-acp/pull/443 ; port of the one-click release workflow from ranxianglei/billion-context#772 (built there as #944 core + #978 green-on-prepared fallback + #994 generated changelog body + #1017 stale-branch collision fix)

## 1. Background & Problem Statement

- **Context**: Releases in this repo are already CI-automated end-to-end — merging a date-prefixed release branch (`YYYY-MM-DD_release-v{V}`) triggers `release.yml`, which tags, gates, publishes to npm, and creates the GitHub Release. What is still manual is *preparing* that release: bumping `package.json` + `package-lock.json`, pushing a branch, opening the PR, writing the changelog body. Every release therefore costs a round of manual bookkeeping before CI takes over.
- **Current behavior**: A human must locally edit two files, commit as `release v{V}`, push a correctly named branch, open a PR with a changelog body, then merge. Error-prone naming (release.yml only detects the branch name in the merge commit message) and duplicated bookkeeping are the recurring pain points.
- **Goal**: An Actions button ("Release (one-click)") that does all preparation automatically: resolve version → guard against drift → minimal bump → full pre-flight gate → land on master directly if allowed (publish in the same run) or prepare a correctly-named release branch + best-effort auto-PR otherwise (human merges; existing `release.yml` publishes).
- **Impact**: One click per release instead of manual file edits + branch + PR; version and branch naming can no longer be mistyped; the pre-flight gate runs in every path (direct or fallback), so nothing untested is ever published.

## 2. Usage / Reproduction

- Actions tab → **Release (one-click)** → Run workflow.
- `version` input blank = auto next-patch over npm `latest` (e.g. `1.18.2` → `1.18.3`). Type an explicit semver (`x.y.z` or `x.y.z-prerelease`) for minor/major/prerelease releases.
- Expected outcomes:
  - Direct push allowed → run publishes to npm + tag + GitHub Release and stays green.
  - Direct push blocked by branch protection (this repo's normal case) → run stays **green** ("prepared" state), release lives on branch `YYYY-MM-DD_release-v{V}` (+ `-HHMMSS` suffix on name collision), job summary carries the auto-opened release PR link (or a one-click `/pull/new` link if auto-PR fails). Human merges with a **standard merge commit** → `release.yml` detects the merge and publishes via CI.

## 3. Constraints & Non-Goals

- **Constraints**:
    - New file only: `.github/workflows/release-manual.yml`. No product code touched.
    - Pre-flight gate MUST mirror this repo's own `release.yml` gate exactly: `npm ci` + `npm run check:package` + `npm test` (no separate build step), `actions/setup-node@v4` with node 22, `cache: npm`, registry npmjs.
    - No hardcoded references to another repo's package name — the npm target is read dynamically from `package.json` (`node -p "require('./package.json').name"`).
    - Auto-bump starts from `npm latest` (the stable lane), matching this repo's dev/stable tag model.
    - Drift guard: master's `package.json` version must equal npm `latest`, else abort loudly (prevents publishing over an unpublished manual change).
    - The fallback branch name MUST match `release.yml`'s detection regex (`Merge pull request #[0-9]+ from .*[0-9]{4}-[0-9]{2}-[0-9]{2}_release-v`) — hence the generated release PR must be merged with a standard merge commit (squash/rebase drops the branch name from the commit message and `release.yml` skips publishing).
    - Existing `release.yml` (including its `workflow_dispatch` force input) stays untouched; the new workflow is separately named "Release (one-click)" so both appear distinctly in the Actions dropdown.
- **Non-Goals**:
    - No changes to product code, config schema, state format, or persistence.
    - No changes to `pr-checks.yml` / `ci.yml` / `release.yml`.
    - Not automating the final merge (human-only operation per AGENTS.md §5.1.1.2).

## 4. Acceptance Criteria

- **Correctness**:
    - [x] Workflow YAML parses; every inline `run:` script passes `bash -n`.
    - [x] Zero hardcoded references to another repo's package name (npm target read dynamically from `package.json`).
    - [x] Version resolution: explicit semver validated by regex; blank input auto-bumps patch over `npm view <pkg> version`.
    - [x] Drift guard aborts when master `package.json` != npm `latest`, and when the target version is already published.
    - [x] Bump touches ONLY `package.json` + `package-lock.json`; verify step asserts the staged diff contains exactly those two files.
    - [x] Pre-flight gate identical to `release.yml`'s: `npm ci` / `npm run check:package` / `npm test`.
    - [x] Direct-push path: commit `release v{V}` pushed to master continues in-run to tag + `npm publish --tag {latest|dev}` + GitHub Release (prerelease when version contains `-`).
    - [x] Fallback path: branch `YYYY-MM-DD_release-v{V}` (timestamp-suffixed on stale collision), best-effort auto-PR with generated changelog (`git log --no-merges LAST_TAG..HEAD~1`), run stays GREEN, PR link + release notes in job summary; one-click `/pull/new` link if auto-PR is blocked.
    - [ ] First real use: drift guard passes (master currently matches npm `latest`, so it will not trip).
- **Performance / Stability**:
    - [x] Single job, single concurrency group (`one-click-release`, no cancel-in-progress); no new dependencies, no runners other than `ubuntu-latest`.
- **Regression**: N/A — CI-only change; existing test suite untouched (green on the PR: test(22)/test(24)).

## 5. Proposed Approach

- **Affected files**: `.github/workflows/release-manual.yml` (NEW, ~263 lines, 13 steps) + this devlog entry.
- **Flow** (13 steps): checkout (fetch-depth 0) → setup-node (node 22, cache npm, registry npmjs) → Resolve version → Drift guard → Bump version (string-replace `"version": "<old>"` in package.json + package-lock.json) → Verify bump diff (staged diff == exactly those two files) → Pre-flight gate (`npm ci && npm run check:package && npm test`) → Commit and push to master (id `push`; sets `direct=true` or `needs_pr=true` + `pr_branch`) → Open fallback PR (best effort, `continue-on-error`; generated changelog body from last `v*` tag to `HEAD~1`, i.e. excluding the release commit itself; writes job summary in all outcomes) → Check if prerelease (`direct` only) → Create tag (`direct` only) → Publish (`direct` only, `NPM_TOKEN` secret) → Create GitHub Release (`direct` only, REST API, prerelease flag honored).
- **Why "green-on-prepared"**: in this repo branch protection blocks direct pushes, so the common outcome is "release prepared on a branch". Failing the run in that case would make the happy path look like an error; instead the run succeeds and surfaces the PR link (and a one-click `/pull/new` escape hatch) in the job summary. Nothing is published until a human merges, preserving the human-in-the-loop rule.
- **Risks**: the coupling to `release.yml`'s merge-title regex means squash/rebase merges of the generated PR silently skip publishing — documented in the PR description Note.
- **Rollback strategy**: delete the single new file; no state, persistence, or API impact.
