# WORKLOG: hide-consumed callID-aliasing leak (issue #288)

## Root cause

`lib/compress/hide-consumed.ts` built `activeCallIds` keyed on `compressCallId`,
then kept/dropped whole tool parts atomically. Because `compressCallId` is shared
by all sibling blocks from one batched `compress({content:[...]})` call, a single
live sibling rescued the whole part → consumed siblings' summaries leaked and were
unreclaimable (`compress` is in the default protected-tools list).

Verified data model:
- `CompressionBlock` carries `startId`/`endId` string refs (`lib/state/types.ts:57-58`).
- `lib/compress/range.ts:347-348` writes `block.startId/endId = entry.startId/endId`
  for every content[] entry, all sharing one `compressCallId`.
- The leaked summary text lives at `part.state.input.content` (an array of
  `{startId,endId,summary}` entries). SDK `ToolState.input` is `{[key:string]:unknown}`.
- `hidden` return value is ignored at both call sites (`hooks.ts`, `status.ts`).

## Fix

`lib/compress/hide-consumed.ts`:

1. Group every block by `compressCallId`; for each LIVE member record its
   `rangeKey = ${startId}::${endId}`. A callId is kept iff >=1 live member.
2. For kept batches with mixed liveness, `rewriteCompressInput(part, liveKeys)`
   filters `part.state.input.content` to entries whose rangeKey is live. Returns
   a shallow clone `{...part, state:{...state, input:{...input, content:kept}}}`
   — never mutates the original part. Returns `null` when all entries are live
   (`kept.length === content.length`) OR matching missed (`kept.length === 0`,
   safe fallback leaving the part intact rather than risk dropping a live summary).
3. All-consumed batch → part fully removed (unchanged).
4. Orphan logic (keep last 2 failed calls) unchanged.

Keyed per-block (on `startId::endId`), not per-callId, because callId is 1:N under
batching. The invariant enabling per-block matching: a block's `startId`/`endId`
equal the `content[]` entry's refs that created it (range.ts:347-348).

## Tests (`tests/hide-consumed.test.ts`, +3)

- `batched compress: rewrites kept part to drop consumed sibling entries (issue #288)`
  — core regression. Verified FAILS with pre-fix code, PASSES after.
- `batched compress: no rewrite when all sibling blocks are live`.
- `batched compress: fully removed when all sibling blocks consumed`.

## Verification

- `tsc --noEmit`: clean.
- `npm run build`: success (388 KB bundle).
- Full suite: 957 pass / 0 fail.
- §5.7 bug-fail check: reverting `hide-consumed.ts` to github/master makes the
  core regression test fail (`✖`); restoring the fix → 14/14 in the file.

## Counterpart

Same defect in `acp-kernel` `src/hide-consumed.ts` — fixed in a separate PR
(kernel types differ: `CoreMessage` has `toolName`/`toolCallId`, `state.blocks`
is an array; returns new message array rather than in-place mutate).
