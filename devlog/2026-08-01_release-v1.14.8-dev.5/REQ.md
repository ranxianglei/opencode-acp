# REQ — v1.14.8-dev.5 Release

## Summary

Dev prerelease bumping `context-compress-algorithms` from 1.2.1 to 1.3.0.

## Motivation

cc-alg 1.3.0 ships holistic TIER2/TIER3 compression prompts that summarize by
theme instead of per-block. This fixes the length overflow issue when compressing
70+ T1 blocks (Issue #256) — the old per-block format produced ~30K char summaries
that exceeded `maxSummaryLengthHard` (20000).

## Scope

- PR #257: bump cc-alg dependency from 1.2.1 → 1.3.0
- No source code changes (prompts consumed from dependency)
- Dev prerelease for early testing on `dev` npm tag

## Acceptance Criteria

- [x] Version bumped to `1.14.8-dev.5`
- [x] README.md + README.zh-CN.md changelog updated
- [x] CI passes (5/5 checks)
- [x] PR created
