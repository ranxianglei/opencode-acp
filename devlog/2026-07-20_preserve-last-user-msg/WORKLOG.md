# WORKLOG - Preserve latest user msg when compress range covers all user msgs

- Task ID: `2026-07-20_preserve-last-user-msg`
- Home Repo: `opencode-acp`
- Status: Done
- Updated: 2026-07-21

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
- **Behavior / compatibility changes**:
  - Persisted state format unchanged. The restore is purely a transform-time
    view operation; `byMessageId` still records the message as compressed.
  - **New default `pruneNotification: "off"`** (was `"detailed"`). Compression
    events now log to `~/.config/opencode/logs/acp/` by default without
    surfacing a toast to the user. Rationale: toasts were perceived as
    over-intrusive for a routine background operation. Users who want the
    toast can set `"minimal"` or `"detailed"` explicitly.
  - **New default `compress.maxSummaryLengthHard: 20000`** (was `10000`).
    The old 10K cap rejected ~25% of model-written summaries that were
    information-dense and useful; 20K aligns with observed good-summary
    lengths in real sessions.
- **Risk level**: Low.

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| (this PR) | fix: preserve most recent user msg when compress range covers all user msgs |

### Key Files

- `lib/messages/prune.ts` — `filterCompressedRanges` rewritten as two-pass with
  preserve-last-user safety net.
- `lib/config.ts` — defaults updated: `pruneNotification: "off"`,
  `compress.maxSummaryLengthHard: 20000`.
- `lib/ui/notification.ts` — `sendCompressNotification` always logs compression
  events to the ACP logger before the `"off"` early-return, so events are
  observable in `logs/acp/` even when toast is disabled.
- `dcp.schema.json` — four stale defaults synced: `pruneNotification "off"`,
  `pruneNotificationType "toast"`, `maxSummaryLengthHard 20000` (both the
  property default and the `compress.default` block).
- `README.md` — Default Configuration section updated (`pruneNotification: "off"`).
- `tests/prune.test.ts` — 5 regression tests + minimal `setupBlock` helper
  (sets up only `byMessageId`, the sole field `filterCompressedRanges` reads)
  covering: restore-when-all-pruned, no-over-restore, multi-user-picks-most-recent,
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

### Why `pruneNotification` default changed to `"off"`

Toasts fire on every compress call. In long sessions with frequent compression
(10–30 compressions per session is typical), this is over-intrusive — the user
did not ask for a popup each time the model manages its own context. The
compression is a routine background operation, not a user-facing event.

The always-log path added to `lib/ui/notification.ts` ensures compression
events are still recorded in `~/.config/opencode/logs/acp/daily/<date>.log`
for debugging, so `"off"` loses no observability — only the UI noise.

Users who want notifications can opt in via `"minimal"` (one-line toast) or
`"detailed"` (full context transition + topics).

### Why `maxSummaryLengthHard` (20000) differs from `gc.maxOldGenSummaryLength` (3000)

These are two independent limits operating at different times for different
purposes — the asymmetry is intentional, not drift:

- **`compress.maxSummaryLengthHard: 20000`** — **write-time** limit, enforced
  in `lib/compress/range.ts` when the model calls `compress`. If the summary
  exceeds this, the compress call is **rejected** (not truncated) and the model
  must retry with a shorter summary. 20K allows dense, detailed summaries that
  preserve critical content (file paths, code signatures, decisions). Observed
  good summaries in real sessions range 2K–12K chars; 20K gives headroom for
  large multi-range batches without rejecting useful work.

- **`gc.maxOldGenSummaryLength: 3000`** — **GC-time** limit, enforced by
  `runTruncateGC` in `lib/gc/truncate.ts`. Fires only when context usage
  exceeds `majorGcThresholdPercent` (default `"100%"` — i.e., context is
  completely full). At that point, old-gen blocks (promoted after
  `promotionThreshold: 5` survivals) have their summaries **truncated** to
  3000 chars as a last-resort pressure-relief valve. Young-gen blocks keep
  their full summaries.

The write-time limit is generous (don't reject useful work); the GC-time limit
is aggressive (when context is full, sacrifice detail to stay operational).
A block can be written at 18K chars, serve the model well for many turns, then
get truncated to 3K only when the session is critically full and the block has
aged into old-gen. This is the intended lifecycle.

## 4. Validation

- `npm run typecheck` — clean (0 errors).
- `npm test` — 803 tests pass (798 pre-existing + 5 new).
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
