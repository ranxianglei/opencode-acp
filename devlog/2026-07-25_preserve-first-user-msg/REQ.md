# REQ — preserve-first-user

## Problem

Sessions freeze with `APIError 400, code 1214, "messages 参数非法"` (zhipuai-lb
rejects requests with zero user-role messages). Reproduced in
`ses_0b89319b1ffeK25eKU3GMfCK8U`: pre-compress 128 msgs / 12 user, post-compress
11 msgs / **0 user**. A month-long bug.

## Root cause

`filterCompressedRanges` (lib/messages/prune.ts) had a `preserve-last-user`
fix (v1.13.2, commit `1044a42`) that restored the most recent pruned user
message when filtering would otherwise leave zero user messages. The fix
searched `messages[i].info.role === "user" && !survive[i]`, depending on the
pruned user message still being present in the `messages` array. After OpenCode
compaction, pruned messages are not guaranteed to still be in the array — so the
restore found nothing and zero-user requests slipped through.

## Solution

Replace `preserve-last-user` with `preserve-first-user`: the first user message
in the session (the original task) is always `survive=true`, unconditionally,
regardless of prune state. OpenCode never deletes the first user message, so
this guarantee always holds and does not depend on array integrity.

## Acceptance criteria

- `lib/messages/prune.ts`: first user message force-preserved
- `tests/prune.test.ts`: 5 `preserve-last-user` tests rewritten for the new
  invariant; the "zero user msgs at all" test still passes unchanged
- `npm run typecheck` clean
- `npm test` all green
- `npm run build` clean
