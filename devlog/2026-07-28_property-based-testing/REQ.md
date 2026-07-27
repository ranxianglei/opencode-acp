# REQ — Property-Based Testing for Nudge Pipeline

## Problem

The nudge injection pipeline (`lib/messages/inject/inject.ts`) has had 4 bugs in rapid succession (v1.14.1-v1.14.4), all caused by state interactions and ordering dependencies that scenario tests didn't cover:

- v1.14.1: baseline reset when `nothingToCompress` was true
- v1.14.2: giant compressible ranges spanning the protected zone
- v1.14.3: hard-reject instead of soft-filter when protection was active
- v1.14.4: nudge text injected even when nothing to compress (loop bug)

**Root cause**: Scenario tests only cover paths the developer thought of. The bugs occurred in paths nobody thought to test.

## Goal

Introduce **property-based testing** via `fast-check` to verify fundamental invariants hold across thousands of randomly generated inputs. Instead of "given input X, assert output Y", we write "for ALL inputs, property P must hold".

## Scope

1. Add `fast-check` as devDependency
2. Create `tests/property-invariants.test.ts` with property-based tests
3. Test 7 invariants that would have caught all 4 recent bugs:

| INV | Description | Catches |
|-----|-------------|---------|
| INV1 | `excludeProtectedRanges` never returns ranges touching protected refs | v1.14.2 giant group |
| INV2 | `buildCompressibleRanges` groups never span protected boundary | v1.14.2 giant group |
| INV3 | `computeProtectedRefs` always includes last N visible messages | correctness |
| INV4 | `computeShouldNudge` returns false when not over limits | v1.14.4 unnecessary nudge |
| INV5 | `filterRecommendedRanges` suppressed ⟹ effective < threshold | correctness |
| INV6 | Pipeline: nudge text injected ⟹ shouldInjectThisTurn is true | v1.14.4 loop |
| INV7 | Pipeline: compress attempt ⟹ all anchors cleared | v1.14.4 failed compress |

## Out of Scope

- No production code changes — tests only
- No extraction of pure functions (deferred to follow-up if POC proves valuable)
- No TLA+/Dafny formal verification (discussed, deferred)
