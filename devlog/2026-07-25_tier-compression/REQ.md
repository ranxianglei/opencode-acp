# 3-Tier Compression (LSM Tree Architecture)

## Problem
Summary blocks accumulate indefinitely (v1.13.5+ force-protection). At ~7.3K tokens/day growth rate, sessions hit the 100K summary ceiling in ~3 days. 92.5% of ancient blocks are shipped/historical work with zero actionable value.

## Solution
Implement a 3-tier LSM Tree compression architecture:
- **Tier 1** (default): Full-detail compression of conversation ranges (existing behavior)
- **Tier 2**: Distillation of old tier-1 summaries → decisions/outcomes only (~1/12 ratio)
- **Tier 3**: Ultra-condensation of tier-2 summaries → bare facts (~1/3 ratio)

End-to-end: 1/60 × 1/12 × 1/3 = 1/2160. Session longevity: 3 days → 271 days (9 months).

## Design
- Reuse existing `compress` tool for all tiers — `b` prefix (block ID) auto-detects tier
- Each tier uses different prompt rules (from cc-alg)
- `block.tier` field on CompressionBlock tracks tier (1/2/3, undefined=1)
- `applyCompressionState` auto-detects output tier from consumed blocks
- Per-tier token counting via `getTierTokenUsage()`
- `computeTierTrigger()` from cc-alg decides when to nudge tier 2/3

## Scope
- **cc-alg**: TIER2_DISTILL_RULES, TIER3_CONDENSE_RULES prompts + computeTierTrigger/computeTierBudgets
- **opencode-acp**: block.tier field, tier auto-detection, per-tier counting, tier nudge injection, system prompt update

## Status
Local development only — not publishing until integration testing complete.
