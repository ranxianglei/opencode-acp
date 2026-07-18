# REQ: v1.12.10-dev.1 Release

## Goal

Publish a dev prerelease to npm `dev` tag bundling the three nudge/recommendation quality fixes merged to master after v1.12.9:

- **PR #157** — `[PROTECTED: ...]` label only lists tools that trigger protection (not every tool in the message)
- **PR #158** — Suppress nudge when all visible content is protected (`allProtected` branch)
- **PR #159** — Discrete 5% check intervals when nudge is suppressed (baseline advance)

## Motivation

User requested a dev prerelease for testing before promoting to stable. The three fixes have passed dual-agent review (Oracle #1 + Oracle #2), 757/757 tests, and local deployment verification.

## Version

- package.json: `1.12.10-dev.1` (prerelease, contains `-`)
- npm tag: `dev` (NOT `latest`)
- GitHub Release: prerelease

## Deliverables

- [x] package.json bumped
- [x] README.md changelog entry
- [x] README.zh-CN.md changelog entry
- [x] devlog entry
- [ ] CI passes (pr-checks + ci)
- [ ] npm publish to `dev` tag (via CI on merge)

## Backward Compatibility

No breaking changes. All three fixes are behavioral refinements to nudge injection logic.

## Rollout

1. Create PR from `2026-07-18_release-v1.12.10-dev` → `master`
2. Human merges PR
3. CI detects prerelease version (contains `-`) → publishes with `--tag dev`
4. Verify: `npm view opencode-acp@dev version` → `1.12.10-dev.1`
5. Install: `opencode plugin opencode-acp@dev --global`
