# WORKLOG - Release v1.13.2

- Task ID: `2026-07-21_release-v1.13.2`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-07-21

## 1. Summary

Patch release shipping PR #169 (preserve-last-user-msg + config defaults tuning).

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| PR #169 | fix: preserve most recent user msg when compress range covers all user msgs |
| PR #169 | fix(config): silence compression toast by default, raise summary cap to 20K |
| PR #169 | refactor(test): simplify prune setupBlock helper |
| PR #169 | docs(devlog): document config defaults rationale and fix test count |
| (this release) | release: v1.13.2 |

### Version bump

- 1.13.1 → 1.13.2

### Changelog

- README.md: v1.13.2 entry added
- README.zh-CN.md: v1.13.2 entry added

## 3. What's in this release

### preserve-last-user (lib/messages/prune.ts)

Two-pass `filterCompressedRanges`:
1. Pass 1: compute which messages survive compression.
2. If no user-role message survives, un-prune the most recent pruned user msg.
3. Pass 2: build the result array.

The restore is transform-time only. `byMessageId` still records the message as
compressed — future compress calls see the correct state.

This closes the second path to the zhipuai-lb code 1214 freeze. The first path
(empty notification user message) was closed in v1.13.1.

### Config defaults tuning (lib/config.ts, lib/ui/notification.ts)

- `pruneNotification: "detailed"` → `"off"`. Compression events now log to
  `~/.config/opencode/logs/acp/daily/<date>.log` via a new always-log block
  in `sendCompressNotification`. No toast by default. Users can opt in via
  `"minimal"` or `"detailed"`.
- `compress.maxSummaryLengthHard: 10000` → `20000`. The old cap rejected
  ~25% of information-dense summaries in real sessions.

### Schema sync (dcp.schema.json)

4 stale defaults aligned with code:
- `pruneNotification`: `"detailed"` → `"off"`
- `pruneNotificationType`: `"chat"` → `"toast"`
- `maxSummaryLengthHard` (property default): `4000` → `20000`
- `maxSummaryLengthHard` (compress.default block): `3000` → `20000`

## 4. Validation

- `npm run typecheck` — clean.
- `npm test` — 803 tests pass.
- `npm run build` — success (dist/index.js 425 KB).
- CI `check-pr.sh` — branch name, devlog, changelog all pass.

## 5. Follow-up

- After merge, CI auto-tags `v1.13.2` and publishes to npm `latest`.
- Verify: `npm view opencode-acp version` shows `1.13.2`.
