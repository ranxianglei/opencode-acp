# WORKLOG - Release v1.11.1

- Task ID: `2026-07-11_release-v1.11.1`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-07-11 17:30

## 1. Summary

- **What was done**: Version bump to 1.11.1, README changelog update (EN + ZH), devlog entry creation. Released via PR after fixing AGENTS.md compliance issues identified in issue #25 review.
- **Why**: v1.11.1 was already published to npm but GitHub master was not synced (branch protection blocked direct push). Initial PR #102 was missing devlog and changelog per AGENTS.md requirements.
- **Behavior / compatibility changes**: No
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| `c39c42d` | chore: bump version to 1.11.1 |
| (this commit) | docs: add v1.11.1 changelog + devlog entry |

### Key Files

- `package.json` — version bumped from 1.11.0 to 1.11.1
- `README.md` — added v1.11.1 changelog entry (English)
- `README.zh-CN.md` — added v1.11.1 changelog entry (Chinese)
- `devlog/2026-07-11_release-v1.11.1/REQ.md` — requirement document
- `devlog/2026-07-11_release-v1.11.1/WORKLOG.md` — this file

## 3. What v1.11.1 Contains

Two bug fixes from PR #99 (`2026-07-11_compress-baseline-fix`):

1. **`lastPerMessageNudgeTokens`** — On compress detection, set to `undefined` instead of `currentTokens`. The old value reflected pre-compression context (from the compress-calling assistant message), causing `growth = postCompress - preCompress < 0`, so nudges never fired after compress.

2. **`lastToolOutputNudgeTokens`** — Same bug, same fix. Not cleared on compress, stayed at stale pre-compression value, delaying tool-output reminder nudges until tool tokens exceeded the stale baseline + threshold.

Both fixes use the same 2-phase pattern: compress → set `undefined` → next transform re-establishes baseline from real post-compression API token count.

Tests: 2 new tests added (`tests/inject.test.ts`) for tool-output baseline clearing + re-establishment. 3 existing tests updated for per-message baseline. Total: 621 tests pass.

## 4. Testing & Verification

### Build & Test Commands

```sh
npm run typecheck     # 0 errors
npm run test          # 621 tests pass, 0 fail
npm run check:package # build + verify passed
```

### Results

- **PASS**: All checks passed
- npm registry: `opencode-acp@1.11.1` verified via `npm view opencode-acp version`
- Local deploy: deployed to `~/.cache/opencode/packages/opencode-acp@latest/`

## 5. Process Issues Identified

- Initial version bump was committed directly to local master, bypassing the PR workflow (AGENTS.md Section 5.1.1)
- GitHub branch protection correctly blocked the direct push
- PR #102 was created but missing devlog (Section 5.1.2) and README changelog
- This PR fixes all compliance issues

## 6. Follow-ups

- [ ] After merge: verify GitHub master shows version 1.11.1
- [ ] After merge: sync local master with GitHub master
