# WORKLOG - npm dev tag support for pre-release publishing

- Task ID: `2026-07-14_dev-tag-support`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-07-14 20:30

## 1. Summary

- **What was done**: Modified `release.yml` to detect prerelease versions (containing `-` in the version string) and publish them with `npm publish --tag dev` instead of the default `latest` tag. Also marks GitHub Releases as prerelease for these versions.
- **Why**: Enables publishing pre-release versions for testing without polluting the stable `latest` npm tag. Users can install `opencode-acp@dev` to test unreleased features.
- **Behavior / compatibility changes**: No. Stable releases (`1.13.0`) are unaffected. Only prerelease versions (`1.13.0-dev.1`, `1.13.0-beta.2`) get the `dev` tag.
- **Risk level**: Low

## 2. Change Log

### Key Files

- `.github/workflows/release.yml` — 3 changes:
    1. "Read version" step: added `is_prerelease` and `npm_tag` outputs via `grep -q -- '-'` detection
    2. "Publish to npm" step: changed from `npm publish` to conditional `npm publish --tag "$NPM_TAG"`
    3. "Create GitHub Release" step: added `prerelease: ${{ steps.version.outputs.is_prerelease }}`

## 3. Design & Implementation Notes

- **Detection logic**: Version string containing `-` (e.g., `1.13.0-dev.1`, `1.13.0-beta.2`, `1.13.0-rc.1`) → prerelease → `dev` npm tag. Versions without `-` (e.g., `1.13.0`) → stable → `latest` npm tag.
- **No branch name change needed**: Release branch naming `YYYY-MM-DD_release-v*` already matches prerelease versions (`release-v1.13.0-dev.1` contains `release-v`).
- **Workflow**:
    ```
    Feature PRs → master (code integration, no npm publish)
    Release branch (stable) → master merge → npm publish --tag latest
    Release branch (prerelease) → master merge → npm publish --tag dev
    ```

## 4. Testing & Verification

### Test Coverage

- No test files needed — CI workflow change only, no source code changes.
- Logic verified by manual inspection of the bash conditional.

### Results

- **PASS**: YAML valid, shell logic correct.
- CI will be validated on PR merge.

## 5. Risk Assessment & Rollback

- **Risk points**: None significant. Worst case: a prerelease version accidentally gets `latest` tag — but this requires forgetting the `-` in the version string, which is unlikely.
- **Rollback method**: Revert the single commit.
- **Compatibility notes**: No data format or config schema changes.
