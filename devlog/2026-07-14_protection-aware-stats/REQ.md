# REQ: Protection-Aware Compressible Ranges & Stats

## Problem Statement

The model's context statistics were "inflated" — they included protected tool outputs that can never be compressed. Three places lacked protection awareness:

1. **`buildCompressibleRanges`** (inject/utils.ts): Listed ALL messages as compressible, including protected ones. Model saw inflated ranges, tried to compress, then most content was silently filtered → ineffective compression or wasted turns.

2. **`estimateContextComposition`** (inject/utils.ts): Nudge breakdown showed total tool/code/text tokens without distinguishing protected (uncompressible) from compressible. Model couldn't tell how much was actually compressible.

3. **`acp_status`** (compress/status.ts): Overview and uncompressed views showed the same inflated ranges.

## Solution

Pass `protectedTools` and `protectedFilePatterns` through to all three functions:

- **`buildCompressibleRanges`**: Skip messages containing protected tools → ranges only show actually compressible content
- **`estimateContextComposition`**: Track `protectedTokens` separately → nudge breakdown shows "X tokens protected — not compressible"
- **`acp_status`**: Uses the same updated functions → consistent with nudge

## Acceptance Criteria

- [x] `buildCompressibleRanges` filters protected messages
- [x] `estimateContextComposition` tracks `protectedTokens`
- [x] Nudge breakdown shows protected tokens warning
- [x] `acp_status` uses protection-aware functions
- [x] Backward compatible (optional params, defaults to no filtering)
- [x] TypeScript: pass
- [x] Tests: 672 pass (666 + 6 new)
