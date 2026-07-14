# REQ: mark_block + Batch Cleanup

## Problem

ACP blocks are only-in-not-out: the model can create (compress) and restore (decompress) but cannot delete. The only deletion mechanism is GC (age-based deactivation at survivedCount > maxBlockAge, threshold truncation at 100% context).

Two issues:

1. **GC age-deactivation fires at low context pressure** — blocks deleted purely by age, even at 30% context. Loses important info (task_ids, session_ids) unnecessarily.
2. **Model has no way to clean up blocks it no longer needs** — blocks accumulate until GC eventually nukes them.

## Solution

Separate "intent" from "execution":

1. **`mark_block` tool** — model marks a block as "no longer needed". Zero cache impact (doesn't modify context, only sets internal flag). Block stays in context with full cache hits.

2. **Batch cleanup at 3 context-pressure thresholds** — when pressure rises, ACP processes all marked blocks in one operation (one cache break, maximum benefit):
    - **Low threshold (~60%)**: nudge the model — "N blocks marked for cleanup, consider merge-compressing them"
    - **High threshold (~75%)**: automatic merge-compress of all marked blocks
    - **Near-100 (~90%)**: force merge-compress ALL old blocks (marked or not) as new fallback before GC

3. **Keep existing GC** as ultimate fallback (100%). Remove later when batch cleanup is stable.

## Key constraint

Prefix-cache: any change to context prefix causes cache miss from that point. Batch cleanup minimizes cache breaks by deferring all modifications to a single operation at high pressure.

## Non-goals

- Do NOT delete original messages from DB (too risky, may break replay/export)
- Do NOT remove GC yet (keep as fallback, remove in future PR when stable)
