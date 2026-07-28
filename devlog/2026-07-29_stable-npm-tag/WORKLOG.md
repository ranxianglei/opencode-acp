# WORKLOG: Add npm stable dist-tag support

## Changes
- `.github/workflows/release.yml`:
  - Added `promote_stable` input to `workflow_dispatch`
  - Added `promote-stable` job: runs `npm dist-tag add opencode-acp@VERSION stable` when triggered
  - Guarded `publish` job with `if: promote_stable == '' || event == push` to prevent both jobs running simultaneously

## Verification
- YAML syntax valid (GitHub Actions schema)
- `publish` job logic unchanged when `promote_stable` is empty
- `promote-stable` job only runs when `promote_stable` input is non-empty
