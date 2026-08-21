# REQ — Effective Compressible Accounting (Retry-Loop Fix)

## Problem

Issue #37 session `ses_7fb5cbc89d7ee8ky0AsO7Wrp7X` showed a repeated-compression loop:

1. **Phantom loop (floors 156-175, ~10 retries)**: The nudge recommended range
   `m00141–m00150` as "7.8K compressible | 3.4K protected". The model compressed it
   successfully 4× (b23–b26), but the remaining uncompressed messages were: the last
   user message (soft-filtered by `filterLastUserMessage`), 2 protected compress
   anchors, and 1 empty message — all filtered by the pipeline. Every retry failed
   with "all messages already compressed" (phantom), and the nudge kept recommending
   the same range → infinite loop.

2. **Min-size retry (floors 204-206)**: After a successful compression (b27), the
   nudge immediately recommended `m00199–m00207` as "10.8K compressible". The actual
   pipeline-compressible content was 3066 chars (protected zone + soft filters) →
   rejected by `minCompressRange` (5000) → retry.

3. **Squeezed-context pressure**: After the context was fully compressed, the
   remaining "compressible" content was 108-token compress confirmations
   (individually sub-minimum). The growth-gated nudge kept firing anyway.

## Root Cause

The recommendation engine (`buildCompressibleRanges`) counts raw visible-message
tokens without applying the compress pipeline's soft filters (last-user-message,
no-meaningful-content, protected zone). The display overstates what a compression
would free by 3.6× in the incident, baiting the model into guaranteed-failed calls.

## Fix

1. `buildCompressibleRanges` now computes per-range `effectiveTokens`: the token sum
   of messages that survive the pipeline's soft filters (excludes the last user
   message and content-empty messages; zone/protected/compressed were already
   excluded).
2. `filterRecommendedRanges` drops ranges with effective content below
   `EFFECTIVE_MIN_COMPRESSIBLE_TOKENS` (1250 tokens ≈ the pipeline's
   `minCompressRange` 5000 chars ÷ 4) — the pipeline would reject them anyway.
3. `formatCompressibleRanges` displays honest sizes ("0.8K effective of 13.6K").
4. `injectCompressNudges` treats all-sub-floor-range states as `nothingToCompress`
   → nudge silenced when nothing is worth compressing (non-emergency path).

## Verification

- §5.7.3: both incident regression tests verified to FAIL when the fix behavior is
  disabled (surgical revert of the floor + allBelowMin).
- 1018 tests pass (up from 1010), typecheck clean.

## Non-Goals

- Emergency-override behavior at maxLimit is unchanged (still nudges even when
  nothing is compressible) — overflow warnings should never be fully silenced.
- The `minCompressRange` pipeline check itself is untouched (remains the backstop).
