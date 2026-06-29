# Context Optimization — Reduce Token Waste

## Problem

Session ses_102504697ffeYg89Sn0k8aknYg grew to 47% context usage. Root cause analysis revealed systematic token waste:

1. **Compress summaries too verbose**: avg 579 chars (~145 tokens), some up to 2011 chars. Include unnecessary metrics, reviewer quotes, experimental parameters.
2. **Compress tool calls are pure overhead**: 344 calls × 813 chars avg = 280K chars. Each stores full summary in input — duplicated with block summary.
3. **Step markers waste space**: 4698 step-start/step-finish parts × ~88 chars avg = 413K chars (~103K tokens). Only mark boundaries, no useful content.
4. **Large tool outputs not compressed**: Model keeps 20-50K char outputs "just in case".
5. **No minimum compress range**: Model compresses tiny ranges (<2K chars) where overhead exceeds savings.
6. **ACP guidance too verbose**: Multi-paragraph nudge text wastes ~200 tokens/turn.

## Requirements

1. **R1**: Limit compress summary length to configurable max (default 100 chars). Reject if exceeded.
2. **R2**: ~~Truncate compress tool input after execution~~ — NOT FEASIBLE (no API to modify stored parts).
3. **R3**: Strengthen nudge to target large tool outputs (>5K chars) explicitly.
4. **R5**: Truncate step markers in context construction (skip step-start, truncate step-finish to 50 chars).
5. **R6**: Shorten ACP guidance text (pressure levels + per-message guidance).
6. **R7**: Enforce minimum compress range (default 2000 chars). Reject if below.

## Cache Safety

All fixes are either cache-neutral (only affect future operations) or one-time breaks that stabilize after deployment. No recurring cache breaks.

## Non-Goals

- Excluding old reasoning from context (causes recurring cache breaks — cancelled).
- Modifying block ID list (accuracy risk — kept as-is).
- compress tool input cleanup (not feasible with current API).
