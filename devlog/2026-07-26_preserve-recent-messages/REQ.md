# REQ: Preserve Recent Messages from Compression

## Problem

When the model calls `compress`, it can include recent messages (active task context) in the compression range. The existing `checkLastSegmentDangerous` only protected the **last 1 visible message** — the model could bypass it by leaving just 1 message after the range.

This caused **task context loss**: the model compressed its own active work history, then lost track of what it was doing and pivoted to unrelated tasks.

## Root Cause

1. `checkLastSegmentDangerous` (`pipeline.ts:236`) only checked `lastVisibleId` — 1 message
2. `filterRecommendedRanges` correctly excluded the last segment from recommendations, but the model could voluntarily extend the range beyond recommendations
3. No enforcement mechanism bridged the gap between recommendation (advisory) and execution (enforced)

## Solution

Replace single-message protection with a multi-rule protected zone:

1. **Last N messages** (default: 20) — protect the most recent visible messages
2. **Last N tokens** (default: 20,000) — protect ~20K tokens expanding backward from the end
3. **Last user message** (default: true) — always protect the most recent user message

All three rules are combined (union). The protected zone is enforced at two layers:
- **Recommendation filter**: Protected ranges excluded from nudge's recommended list
- **Compress enforcement**: `checkProtectedRange` rejects compress calls covering protected messages (unless `dangerous: true`)

## Config

```jsonc
{
    "compress": {
        "preserveRecentMessages": 20,
        "preserveRecentTokens": 20000,
        "preserveLastUserMessage": true
    }
}
```

All fields are optional with defaults. `lastSegmentSoftBlock: false` disables all protection (master switch, same as before).

## Growth Accounting

When all compressible ranges fall within the protected zone, the nudge is automatically suppressed (treated as `nothingToCompress`). This prevents the model from being asked to compress when there's nothing safe to compress.

## Scope

Separate branch from tier-compression (PR #200). This is a bug fix, shipped as v1.13.10 hotfix.
