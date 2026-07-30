# REQ: acp_status shows consumed compress calls as PROTECTED

## Problem

`acp_status` fetches messages directly from the DB via `fetchSessionMessages`,
bypassing the transform pipeline. `hideConsumedCompressCalls` only modifies
`output.messages` in the transform hook — the DB retains original compress parts.

Result: consumed (inactive) compress calls show as `[PROTECTED: compress — not compressible]`
in `acp_status` output, even though they're invisible in the model's actual context.
This confuses the model into thinking there's much more protected content than
actually exists, causing misjudgment about what's available for compression.

## Fix

Call `hideConsumedCompressCalls(state, rawMessages)` in `createAcpStatusTool`'s
execute handler, after `fetchSessionMessages` but before `buildStatusReport`.
This ensures `acp_status` reflects the same message view the model sees.

## Files

- `lib/compress/status.ts` — import + call `hideConsumedCompressCalls`
- `tests/acp-status-consumed-fix.test.ts` — 2 tests (consumed hidden, active visible)
