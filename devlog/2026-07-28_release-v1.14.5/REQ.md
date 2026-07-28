# REQ: Release v1.14.5

## Goal
Release stable v1.14.5 bundling 5 PRs merged since v1.14.4:
- PR #222: Remove GC module, add emergency tool output truncation
- PR #206: Remove dead prune tool, sweep command, strategies (~2309 lines)
- PR #221: Property-based testing POC (10 tests, ~1400 random inputs)
- PR #223: Comprehensive config documentation (CONFIGURATION.md + zh-CN)
- PR #224: Fix Issue #176 — nudge permanently stops after compress in autonomous sessions

## Acceptance Criteria
- [x] Version bumped to 1.14.5
- [x] Changelog entries added to README.md and README.zh-CN.md
- [x] Devlog created
- [x] CI all green (tests + build + e2e)
- [ ] Human merges PR
- [ ] Deploy to local opencode
