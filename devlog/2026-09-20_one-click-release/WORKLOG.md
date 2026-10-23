# WORKLOG - One-click release workflow (workflow_dispatch)

- Task ID: `2026-09-20_one-click-release`
- Home Repo: `opencode-acp`
- Status: InProgress
- Updated: 2026-09-20 13:15

## 1. Summary

- **What was done**: Added `.github/workflows/release-manual.yml` — a `workflow_dispatch` workflow ("Release (one-click)") that automates release preparation: version resolution (auto next-patch over npm `latest`, or explicit semver), drift guard, minimal two-file bump, full pre-flight gate, then either a direct push to master (publishing in-run) or a prepared `YYYY-MM-DD_release-v{V}` branch with a best-effort auto-PR carrying a generated changelog. Ported from ranxianglei/billion-context#772 (#944 + #978 + #994 + #1017).
- **Why**: Manual release bookkeeping (editing package.json/lockfile, naming the branch correctly, writing the PR body) is error-prone and duplicated on every release; the existing `release.yml` already publishes from a correctly-named merge, so only the *preparation* needed automation.
- **Behavior / compatibility changes**: CI-only. No product code, config schema, state format, persistence, or public API changes. Existing `release.yml` untouched.
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `1510f154` | feat(ci): one-click release workflow (workflow_dispatch) |
| `(this commit)` | docs: add devlog entry (REQ.md + WORKLOG.md) required by AGENTS.md §5.1.2 / pr-validation |

### Key Files

- `.github/workflows/release-manual.yml` — NEW. Single job `release`, 13 steps, concurrency group `one-click-release` (no cancel-in-progress), permissions `contents: write` + `pull-requests: write`.
- `devlog/2026-09-20_one-click-release/REQ.md`, `WORKLOG.md` — this entry.

## 3. Design & Implementation Notes

- **Version resolution** (`Resolve version` step): explicit input validated against `^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`; blank input reads the package name dynamically from `package.json` and auto-bumps the patch over `npm view <pkg> version`.
- **Drift guard**: aborts if master `package.json` version != npm `latest` (master must equal the last published release before one-clicking), and if the target version is already published.
- **Bump**: string-replace `"version": "<old>"` → `"version": "<new>"` in exactly `package.json` + `package-lock.json`; the following step stages those two files and asserts `git diff --cached --name-only` equals exactly that pair.
- **Pre-flight gate**: `npm ci && npm run check:package && npm test` — mirrors `release.yml`'s gate exactly (verified line-by-line), with `actions/setup-node@v4` node 22 + `cache: npm` + registry npmjs like the existing workflows.
- **Landing strategy** (`Commit and push to master` step, id `push`): commits `release v{V}`; tries `git push origin HEAD:master` first. On success sets `direct=true` and the run continues to tag → publish → GitHub Release. On failure (branch protection — this repo's normal case) pushes to branch `YYYY-MM-DD_release-v{V}`, appending `-HHMMSS` when that name already exists on origin (stale same-day earlier run of the same version, ported from billion-context #1017), sets `needs_pr=true` + `pr_branch`, and the run continues green.
- **Fallback PR** (`Open fallback PR`, `continue-on-error`): builds a generated changelog body from `git log --no-merges --pretty='- %s' LAST_TAG..HEAD~1` (last `v*` tag → parent of the release commit, so the release commit itself is excluded), opens the PR via REST API with GITHUB_TOKEN, and writes the job summary in every outcome: PR URL when auto-opened, or a one-click `/pull/new/<branch>` link plus paste-ready notes when the account-level Actions restriction blocks auto-PR.
- **Direct-path publish**: prerelease detection (version contains `-` → npm tag `dev` + GitHub Release `prerelease: true`, mirroring `release.yml`); tag push is idempotent (`|| true`); publish uses the repo's `NPM_TOKEN` secret.
- **Coupling note**: the fallback branch name is chosen specifically to match `release.yml`'s Pattern-1 regex (`Merge pull request #[0-9]+ from .*[0-9]{4}-[0-9]{2}-[0-9]{2}_release-v`) — the generated release PR must be merged with a **standard merge commit**; squash/rebase drops the branch name from the merge title and `release.yml` skips publishing. Documented in the PR description Note.

## 4. Testing & Verification

### Build & Test Commands

```sh
# Validate workflow YAML + inline scripts (done locally before PR)
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release-manual.yml'))"   # 13 steps parse OK
bash -n <each inline run block>                                                          # all pass
# Product suite (unchanged by this PR; runs in CI)
npm ci && npm run check:package && npm test
```

### Test Coverage

- N/A for new unit tests — CI-only change, no product code touched. The existing suite runs unchanged in CI (test(22)/test(24) green on this PR).
- Key scenarios verified locally:
  - YAML parses (pyyaml); every `run:` script passes `bash -n`.
  - Zero hardcoded references to another repo's package name — npm target read dynamically from `package.json`.
  - Pre-flight gate matches `release.yml` exactly (`npm ci` / `npm run check:package` / `npm test`; setup-node node 22 cache npm registry npmjs).
  - Fallback branch-name format matches `release.yml`'s detection regex.
  - master currently matches npm `latest`, so the drift guard will not trip on first use.

### Results

- **PASS/FAIL**: PASS — local static verification clean; CI `PR Checks` initially failed ONLY on the missing devlog entry (fixed by this commit); product test/build jobs green.

## 5. Risk Assessment & Rollback

- **Risk points**:
    - Squash/rebase merge of the generated release PR silently skips publishing (regex coupling) — mitigated by the explicit Note in the PR description.
    - If both direct push and fallback branch push fail, the run fails loudly with "nothing published, aborting" — no partial state.
- **Rollback method**: delete `.github/workflows/release-manual.yml` (single-file revert); no state/persistence/API impact.
- **Compatibility notes**: none — no data format or config schema changes.

## 6. Lessons Learned

- What went well: porting an already-proven workflow (billion-context has run it through #944→#1017 hardening) kept the adaptation surface small — only the gate commands and branch-name convention needed re-checking against this repo's `release.yml`.
- Reusable conclusion: "green-on-prepared" (succeed when the release is safely staged behind a human merge) keeps the common path out of the red while preserving human-in-the-loop publishing.

## 7. Follow-ups

- [ ] First real one-click run: confirm drift guard passes and the fallback path lands a correctly-named branch + PR end-to-end (will happen on the next actual release).
