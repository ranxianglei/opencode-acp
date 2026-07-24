# REQ: Release v1.13.5

Release PR to fix the release CI regex and publish all accumulated changes (v1.13.3 + v1.13.4 + CI fix).

## Root cause of skipped releases

`.github/workflows/release.yml` detection regex only matched standard merge commits:
```
Merge pull request #[0-9]+ from .*[0-9]{4}-[0-9]{2}-[0-9]{2}_release-v
```

PRs #182 (v1.13.3) and #186 (v1.13.4) were **squash-merged**, producing commit titles like:
```
release: v1.13.3 — quality gate enforcement... (#182)
```

These don't match the regex → `is_release=false` → all publish steps skipped → npm stuck at 1.13.2.

## Fix

Added second detection pattern for squash merge titles:
```
^release: v[0-9]+\.[0-9]+\.[0-9]+
```

Matches any squash-merged commit whose title starts with `release: vVERSION`.

## What this release includes (accumulated since v1.13.2)

- v1.13.3: Quality Gate Enforcement + E2E Test Framework + protectedTools Fix (PRs #173-#179)
- v1.13.4: Protect Compress Tool Calls from Being Compressed (PR #185)
- v1.13.5: Fix Release CI for Squash Merges (this PR)
