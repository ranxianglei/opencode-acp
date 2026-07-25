# REQ - Release v1.14.0-dev.1

- Task ID: `2026-07-25_release-v1.14.0-dev.1`
- Branch: `2026-07-25_release-v1.14.0-dev.1` (base: `2026-07-24_per-session-state` which merges github/master v1.13.5)
- Type: Dev prerelease (npm `dev` tag)

## Goal

Publish a dev prerelease to npm `dev` tag so users can opt in via `opencode-acp@dev` to test the per-session state registry and nudge baseline fix before a stable release.

## Changes included (since v1.13.5 master)

1. **Per-Session State Registry** (`2026-07-24_per-session-state` branch):
   - `SessionStateRegistry`: `Map<sessionId, SessionState>` with soft cap 32 + oldest-first eviction
   - All hook handlers + compress tools resolve state per-call via `registry.getOrCreate(sessionID)`
   - Eliminates cross-session state contamination for interleaved subagents

2. **Nudge Baseline Fix** (issue #33):
   - `lib/messages/inject/inject.ts:308`: baseline init from `currentTokens` → `0`
   - First nudge now fires at ~5% context (50K on 1M model) instead of ~10.5%

3. **Regression Test**:
   - `tests/inject.test.ts`: "baseline initialized to 0 on first transform, not currentTokens (issue #33 regression)"
   - Verified: FAILS with bug reverted, PASSES with fix

## Prerelease detection

Version `1.14.0-dev.1` contains `-`, so CI `release.yml` will publish with `--tag dev` and mark GitHub Release as `prerelease: true`.
