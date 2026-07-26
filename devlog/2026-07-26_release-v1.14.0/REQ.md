# Release v1.14.0

## Purpose
Publish v1.14.0 stable release to npm `latest` tag.

This release bundles three major PRs merged to master:
- **PR #200**: 3-tier compression (LSM tree architecture) — T1 capture → T2 distill → T3 condense
- **PR #201**: Preserve recent messages from compression (task context loss)
- **PR #202**: Fix summaryBuffer visibility over-counting

## Changes
- `package.json`: version 1.13.9-dev.1 → 1.14.0
- `README.md`: Added v1.14.0 changelog entry
- `README.zh-CN.md`: Added v1.14.0 changelog entry (中文)

## Verification
- No source code changes (release-only)
- Changelog entries added to both README files
