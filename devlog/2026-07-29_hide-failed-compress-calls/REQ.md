# REQ: Auto-cleanup failed compress calls

## Problem

Failed compress tool calls (quality gate rejection, invalid boundaries, permission denied) leave error messages permanently in context. Quality gate rejections alone are ~500 tokens each. Multiple failures accumulate, polluting context.

## Solution

New `hideFailedCompressCalls` function removes all compress tool parts with `status: "error"` from the message array before each LLM call.

## Constraints

- Must run AFTER `injectCompressNudges` in the pipeline — the nudge system needs to see failed compress calls for baseline reset (`messageHasCompressAttempt`). Removing them first would reintroduce issue #216 feedback loop.
- Must NOT remove successful compress calls (those are handled by `hideConsumedCompressCalls` when consumed by higher-tier compressions).
- Must NOT remove failed non-compress tool calls (only compress).
