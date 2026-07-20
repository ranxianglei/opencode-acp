# WORKLOG - Preserve latest user msg when compress range covers all user msgs

- Task ID: `2026-07-20_preserve-last-user-msg`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-07-20 23:30

## 1. Summary

- **What was done** (1–3 sentences):
  Rewrote `filterCompressedRanges` in `lib/messages/prune.ts` as a two-pass filter.
  Pass 1 computes which messages survive; pass 2 builds the result. Between the
  passes, if no user-role message would survive, the most recent pruned user
  message is un-pruned so the API request shape stays valid.
- **Why** (1–3 sentences):
  v1.13.1 closed the empty-notification-user-msg path to zhipuai-lb code 1214,
  but the "compress consumes all user msgs" path was still open. When the model
  compresses a range that extends past the latest user message and no newer user
  message has arrived, the next API call has zero user messages and is rejected
  with `isRetryable: false`, freezing the session.
- **Behavior / compatibility changes**: No. Persisted state format unchanged.
  The restore is purely a transform-time view operation; `byMessageId` still
  records the message as compressed.
- **Risk level**: Low.

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| (this PR) | fix: preserve most recent user msg when compress range covers all user msgs |

### Key Files

- `lib/messages/prune.ts` — `filterCompressedRanges` rewritten as two-pass with
  preserve-last-user safety net.
- `tests/prune.test.ts` — 5 regression tests + `setupBlock` helper covering:
  restore-when-all-pruned, no-over-restore, multi-user-picks-most-recent,
  no-user-no-op, restored-content-byte-identical.

## 3. Design & Implementation Notes

### Why two passes instead of inline tracking

The original code was a single pass that built the result list directly. The
fix needs to know whether ANY user message survives before deciding to restore
the most recent pruned one. Doing this inline requires either:
- Two iterations of the input anyway, or
- A backup variable that gets inserted later (messy index management).

Two passes is the simplest correct shape and costs O(n) extra space for the
`survive: boolean[]` array — negligible for typical message counts.

### Why restore the MOST RECENT user msg, not the oldest

The most recent user message carries the active task instruction. Restoring an
older user message would present stale context to the model. The most recent is
both API-valid and semantically most useful.

### Why not also restore the messages between the user msg and the compress call

That would defeat the compression. The compress summary already captures the
semantic content of those messages. Restoring only the user message is the
minimum needed to satisfy the API contract.

### Interaction with v1.13.1 (`2026-07-20_compress-notification-fix`)

Orthogonal. v1.13.1 fixes `dropEmptyMessages` to discard `ignored: true` text
parts. This PR fixes `filterCompressedRanges` to preserve the last user msg.
If both merge to master, the combined behavior is:
1. `filterCompressedRanges` restores the last user msg if all were pruned.
2. `dropEmptyMessages` removes it if it turns out to be ignored-only.

The only remaining gap: a session where the ONLY user messages are both (a)
inside compressed ranges AND (b) ignored-only. That requires the chat-style
notification path, which v1.13.1 already removed at the source.

### Why the restore does not update `byMessageId`

`byMessageId` is the source of truth for "this message is logically compressed."
The restore is a transform-time view operation — the message IS still
compressed; we just leak one message back into the API request to keep the
shape valid. Updating `byMessageId` would break the compress state model and
cause future compress calls to misbehave.

## 4. Validation

- `npm run typecheck` — clean (0 errors).
- `npm test` — 847 tests pass (842 pre-existing + 5 new).
- `npm run build` — dist/index.js 423 KB, tsup success.
- Regression test "restore most recent user msg when all user msgs fall in
  compressed range" directly reproduces the `ses_0805cd994ffeeIQYQJHkoGlnLR`
  shape and asserts the fix.

## 5. Follow-up

- Once merged, ship in the next release. Recommend combining with the v1.13.1
  notification fix (PR #167) into a single `v1.13.2` release so users get both
  fixes together.
- Consider adding a follow-up that emits a logger warn when the restore path
  triggers, so we can track incidence in the wild.
