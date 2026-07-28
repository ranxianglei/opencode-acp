# WORKLOG: Add npm stable dist-tag promotion via PR

## Changes (v2 — redesigned from workflow_dispatch to PR-based)
- `.github/workflows/release.yml`:
  - Removed `promote_stable` workflow_dispatch input (rejected: no audit trail)
  - Added Pattern 3 + Pattern 4 detection for `promote-stable-v{VERSION}` branch merges
  - Added "Promote to npm stable tag" step: runs `npm dist-tag add opencode-acp@VERSION stable`
  - Expanded `setup-node` condition to cover both `is_release` and `is_promote_stable`
  - All existing release/publish steps unchanged

## Rationale
PR-based promotion provides:
- Git history audit trail (who promoted, when, why)
- PR description documents what changed since last stable
- No manual version input (eliminates typo risk)
- Same merge-based flow as releases — consistent workflow
