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
- Each tier uses different prompt rules (from cc-alg v1.2.1)
- `block.tier` field on CompressionBlock tracks tier (1/2/3, undefined=1)
- `applyCompressionState` auto-detects output tier from consumed blocks (min consumed tier + 1)
- Per-tier token counting via `getTierTokenUsage()`
- Independent tier triggers with T1 priority: each tier checks its input summaries against `nudgeGrowthTokens`
- Tier-aware decompress: default = one level up (T2→T1), `full:true` = recursive to raw
- Cross-tier contamination prevention: candidates sorted by blockId, range narrowed when non-target blocks exist

## Scope
- **cc-alg v1.2.1**: TIER2_DISTILL_RULES, TIER3_CONDENSE_RULES prompts (keep function/module refs, source headers)
- **opencode-acp**: block.tier field, tier auto-detection, per-tier counting, independent triggers, tier-aware decompress, hide-consumed, sync.ts anchor-survival fix

## Session Capacity (real-calibrated)
| Context limit | Total tokens | Duration |
|---------------|-------------|----------|
| 1M | 68.9B | 259 days |
| 400K (500 calls/day) | 10.3B | 89 days |
| 400K (200 calls/day) | 9.5B | 212 days |

## Status
33 commits, 919 tests pass, dual-agent reviewed (all findings fixed).
