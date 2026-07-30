# WORKLOG: acp_status consumed-compress fix

## Implementation

1. Added `hideConsumedCompressCalls` import in `lib/compress/status.ts`
2. Added `hideConsumedCompressCalls(ctx.state, rawMessages)` call after `fetchSessionMessages`, before `buildStatusReport`
3. Wrote 2 tests:
   - "consumed compress calls not shown as PROTECTED after hideConsumedCompressCalls" — verifies the before/after fix behavior
   - "active compress calls still shown as PROTECTED" — verifies active compress calls survive filtering

## Verification

- typecheck: 0 errors
- full test suite: 936/936 pass
